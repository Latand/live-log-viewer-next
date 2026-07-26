/**
 * The root conversation's durable identity and its rollover lineage (#688 D1/D5).
 *
 * D1 gives the operator one persistent root agent and one continuous
 * conversation. D5 makes session *replacement* a normal event: on crash, reboot
 * or context rollover a fresh root session starts, seeded by a structured
 * handoff and linked to the prior timeline. Those two together are why nothing
 * downstream may key on a session path — an attention request created before a
 * rollover has to still resolve after it, and the overlay has to be able to walk
 * back to the session the current one continues from.
 *
 * So the stable thing is the *root identity*, minted once and never replaced.
 * Sessions hang off it in order.
 */

export const ROOT_LINEAGE_SCHEMA_VERSION = 1 as const;

/** Sessions retained per root. Older entries fall off the head of the chain;
    the marker only ever walks one link back, so depth beyond this is history
    nobody navigates. */
export const MAX_ROOT_SESSIONS = 100;

/** Why the previous session stopped being current. `rollover` is the ordinary
    context-limit case; `fresh` is the operator's deliberate "start fresh". */
export type RootRolloverReason = "crash" | "reboot" | "rollover" | "fresh";

export interface RootSessionV1 {
  /** Stable viewer conversation id of this root session. */
  conversationId: string;
  /** Transcript path once the spawn settles one; null while path-pending. */
  path: string | null;
  startedAt: string;
  /** Set when a successor took over. Absent on the current session. */
  endedAt?: string;
  /** The session this one continues from — the continuity marker's destination. */
  seededFrom?: string;
  /** Why the predecessor was replaced. Recorded on the *successor*, because
      that is the session whose timeline has to explain the seam. */
  reason?: RootRolloverReason;
}

export interface RootLineageV1 {
  schemaVersion: typeof ROOT_LINEAGE_SCHEMA_VERSION;
  /** Mints once, never replaced. Every durable reference to "the root agent"
      is this string, never a session path (D5). */
  rootId: string;
  revision: number;
  updatedAt: string;
  /** Oldest first; the last entry is the current session. */
  sessions: RootSessionV1[];
}

/** What the overlay renders at the head of a session that continues another:
    one line, neither a message nor a chip, tapping through to the predecessor. */
export interface RootContinuityMarker {
  /** The session being continued from. */
  previousConversationId: string;
  previousPath: string | null;
  reason: RootRolloverReason;
  at: string;
}

export interface RootAdoption {
  lineage: RootLineageV1;
  /** `created` — first session ever; `current` — the same session, unchanged;
      `settled` — same session, its transcript path arrived; `rolled-over` — a
      successor replaced the previous session. */
  outcome: "created" | "current" | "settled" | "rolled-over";
}
