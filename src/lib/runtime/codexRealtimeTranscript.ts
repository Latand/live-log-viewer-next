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
 *
 * ONE SEGMENT PER UTTERANCE, WHICHEVER FAMILY DESCRIBES IT (#1658). Native
 * 0.154 publishes every segment on BOTH families: `item/started` names the
 * segment, and each `item/transcript/delta` and `item/completed` is followed at
 * once by its flat `transcript/delta` / `transcript/done` mirror. Reducing the
 * two independently put every sentence on the panel twice. The per-item family
 * is the one with an identity, so it owns the segment; the flat family is read
 * for what only it carries, and is the whole transcript only on a server that
 * never publishes items:
 *
 * - `item/completed` carries what the item deltas accumulated, and the flat
 *   `transcript/done` after it carries the provider's own final text. A delta
 *   the provider never streamed is repaired only by the second, so it is applied
 *   to the segment it mirrors — the role's current one.
 * - native opens a segment with an empty `item/started`. Nothing is published
 *   until the segment has words, so an empty line never takes a place on the
 *   panel ahead of the words it is for.
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

/** Segments one call remembers by item id. Native keeps at most one open per
    role, plus the one whose flat mirror has not arrived yet, so this is a guard
    against a malformed stream rather than a working limit. */
const MAX_TRACKED_SEGMENTS = 32;

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

function clip(text: string): string {
  return text.slice(0, MAX_SEGMENT_CHARS);
}

interface Segment {
  id: string;
  role: CanonicalVoiceRole;
  /** What this segment's own family accumulated: item deltas once native named
      an item, flat deltas on a server that never does. */
  text: string;
  /** Flat text published under this id before native named the item, when the
      flat mirror happened to arrive first. Kept as a floor so a newly-named item
      that has not caught up yet never shortens a line already on screen. */
  floor: string;
  /** The provider's final text, from the flat `transcript/done`. */
  doneText: string;
  final: boolean;
  /** Bound to a native item. Its flat mirror only repairs it from then on. */
  item: boolean;
  /** Completed, with the flat `transcript/done` mirroring that completion still
      to come. */
  awaitingDone: boolean;
}

export class CodexRealtimeTranscript {
  /** Segments by native item id. */
  private readonly items = new Map<string, Segment>();
  /** Item deltas that arrived before any notification named their role. */
  private readonly unattributed = new Map<string, string>();
  /** Each speaker's current segment — the one its flat events mirror. */
  private readonly current = new Map<CanonicalVoiceRole, Segment>();
  /** This call has published a per-item transcript, so its flat stream only
      mirrors that one. */
  private itemFamily = false;
  private sequence = 0;
  private realtimeSessionId = "";

  /** A new call is a new transcript: nothing from the last one may be extended,
      and the ids it minted must not be reused. */
  begin(realtimeSessionId: string): void {
    this.reset();
    this.realtimeSessionId = realtimeSessionId;
  }

  end(): void {
    this.reset();
  }

  private reset(): void {
    this.items.clear();
    this.unattributed.clear();
    this.current.clear();
    this.itemFamily = false;
  }

  /**
   * Read one notification, and answer the segment it changed.
   *
   * Null for anything this does not describe, including a notification for
   * another thread — the caller has already filtered by thread, and this keeps
   * the reducer usable on its own — and for a change nobody could see: a
   * segment with no words yet, or a flat event mirroring what its item already
   * said.
   */
  observe(method: string, params: unknown): CanonicalVoiceSegment | null {
    const body = object(params);
    if (!body || !this.realtimeSessionId) return null;
    if (method === "thread/realtime/transcript/delta") {
      const speaker = role(body.role);
      const delta = typeof body.delta === "string" ? body.delta : "";
      if (!speaker || !delta || this.itemFamily) return null;
      return this.flatDelta(speaker, delta);
    }
    if (method === "thread/realtime/transcript/done") {
      const speaker = role(body.role);
      const text = typeof body.text === "string" ? body.text : "";
      if (!speaker) return null;
      return this.itemFamily ? this.repair(speaker, text) : this.flatDone(speaker, text);
    }
    if (method === "thread/realtime/item/transcript/delta") {
      const itemId = string(body, "itemId");
      const delta = typeof body.delta === "string" ? body.delta : "";
      if (!itemId || !delta) return null;
      const segment = this.items.get(itemId);
      if (!segment) {
        /* Native names the item before it streams into it. A delta for an item
           nobody has named yet waits for the started or completed notification
           that carries its role; a guessed speaker would draw the words on the
           wrong side of the panel. */
        if (this.unattributed.size >= MAX_TRACKED_SEGMENTS) this.unattributed.clear();
        this.unattributed.set(itemId, clip((this.unattributed.get(itemId) ?? "") + delta));
        return null;
      }
      if (segment.final) return null;
      segment.text = clip(segment.text + delta);
      return this.publish(segment);
    }
    if (method === "thread/realtime/item/started" || method === "thread/realtime/item/completed") {
      const item = object(body.item);
      if (string(item, "type") !== "transcriptSegment") return null;
      const itemId = string(item, "id") ?? string(body, "itemId");
      const speaker = role(item?.role);
      if (!itemId || !speaker) return null;
      const text = typeof item?.text === "string" ? item.text : "";
      const known = this.items.get(itemId);
      if (method === "thread/realtime/item/started") {
        /* Native repeats `item/started` for a segment it has already opened. */
        return known ? null : this.publish(this.bind(itemId, speaker, text));
      }
      const segment = known ?? this.bind(itemId, speaker, "");
      /* The completion carries the whole segment as native accumulated it. An
         empty one keeps what was streamed, because losing the words would be the
         worse reading of a sparse event. */
      segment.text = clip(text || segment.text);
      if (!segment.final) segment.awaitingDone = true;
      segment.final = true;
      this.current.set(speaker, segment);
      return this.publish(segment);
    }
    return null;
  }

  /**
   * Bind a native item to a segment.
   *
   * The speaker's current segment is adopted when only the flat family has
   * described it so far: that is the same utterance, reached through its mirror
   * first, and a second segment for it is exactly the duplicate this exists to
   * prevent. It keeps the id already published, so its line stays where it is.
   */
  private bind(itemId: string, speaker: CanonicalVoiceRole, text: string): Segment {
    this.itemFamily = true;
    const flat = this.current.get(speaker);
    const pending = this.unattributed.get(itemId) ?? "";
    this.unattributed.delete(itemId);
    const segment: Segment = flat && !flat.item && !flat.final
      ? { ...flat, text: "", floor: flat.text, item: true }
      : {
        id: itemId, role: speaker, text: "", floor: "", doneText: "", final: false, item: true, awaitingDone: false,
      };
    segment.text = clip(text + pending);
    if (this.items.size >= MAX_TRACKED_SEGMENTS) {
      const oldest = this.items.keys().next().value as string | undefined;
      if (oldest !== undefined) this.items.delete(oldest);
    }
    this.items.set(itemId, segment);
    this.current.set(speaker, segment);
    return segment;
  }

  /**
   * The flat `transcript/done` mirroring the speaker's current item.
   *
   * Its text is the provider's complete one, and the item's own completion is
   * only what its deltas accumulated, so this is the repair for a delta that
   * never streamed. A done that is the second copy of what the item already
   * says changes nothing and publishes nothing.
   */
  private repair(speaker: CanonicalVoiceRole, text: string): CanonicalVoiceSegment | null {
    const segment = this.current.get(speaker);
    if (!segment || (segment.final && !segment.awaitingDone)) return null;
    segment.awaitingDone = false;
    const before = this.shown(segment);
    const wasFinal = segment.final;
    if (text) segment.doneText = clip(text);
    segment.final = true;
    return wasFinal && this.shown(segment) === before ? null : this.publish(segment);
  }

  private flatDelta(speaker: CanonicalVoiceRole, delta: string): CanonicalVoiceSegment | null {
    const open = this.current.get(speaker);
    const segment = open && !open.final ? open : this.mint(speaker);
    segment.text = clip(segment.text + delta);
    return this.publish(segment);
  }

  private flatDone(speaker: CanonicalVoiceRole, text: string): CanonicalVoiceSegment | null {
    const open = this.current.get(speaker);
    /* A done with no words and nothing streamed before it is no segment. */
    if ((!open || open.final) && !text) return null;
    const segment = open && !open.final ? open : this.mint(speaker);
    /* The done event carries the WHOLE segment, so it wins over what the deltas
       accumulated: a dropped frame is repaired here rather than left as a hole
       in the middle of a sentence. An empty final text keeps what was streamed. */
    if (text) segment.doneText = clip(text);
    segment.final = true;
    return this.publish(segment);
  }

  private mint(speaker: CanonicalVoiceRole): Segment {
    this.sequence += 1;
    const segment: Segment = {
      id: `${this.realtimeSessionId}:${speaker}:${this.sequence}`,
      role: speaker,
      text: "",
      floor: "",
      doneText: "",
      final: false,
      item: false,
      awaitingDone: false,
    };
    this.current.set(speaker, segment);
    return segment;
  }

  private shown(segment: Segment): string {
    if (segment.doneText) return segment.doneText;
    return !segment.final && segment.floor.startsWith(segment.text) ? segment.floor : segment.text;
  }

  private publish(segment: Segment): CanonicalVoiceSegment | null {
    const text = this.shown(segment);
    if (!text) return null;
    return {
      id: segment.id,
      realtimeSessionId: this.realtimeSessionId,
      role: segment.role,
      text,
      final: segment.final,
    };
  }
}
