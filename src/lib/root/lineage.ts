import {
  MAX_ROOT_SESSIONS,
  ROOT_LINEAGE_SCHEMA_VERSION,
  type RootAdoption,
  type RootContinuityMarker,
  type RootLineageV1,
  type RootRolloverReason,
  type RootSessionV1,
} from "./types";

/**
 * Pure lineage arithmetic for the root conversation (#688 D5). Everything here
 * is a function of a lineage value, so the rollover behaviour every durable
 * reference depends on is testable without touching a state file.
 */

/** The session the operator is talking to right now, or null before the first. */
export function headSession(lineage: RootLineageV1 | null): RootSessionV1 | null {
  return lineage?.sessions.at(-1) ?? null;
}

/**
 * Every session id this root has ever been, newest first.
 *
 * D6 keeps the root conversation off the board, and the artifact is explicit
 * that the filter must hold for the *whole* rollover chain rather than the live
 * session — otherwise every rollover leaves another dead root session on the
 * surface the operator uses most.
 */
export function rootConversationIds(lineage: RootLineageV1 | null): string[] {
  return [...(lineage?.sessions ?? [])].reverse().map((session) => session.conversationId);
}

/** Whether a conversation is (or was) the root, by stable id or transcript path. */
export function isRootConversation(
  lineage: RootLineageV1 | null,
  candidate: { conversationId?: string | null; path?: string | null },
): boolean {
  return (lineage?.sessions ?? []).some((session) => (
    (candidate.conversationId != null && session.conversationId === candidate.conversationId)
    || (candidate.path != null && session.path !== null && session.path === candidate.path)
  ));
}

/** The "continued from earlier" line for the current session, when it has one. */
export function continuityMarker(lineage: RootLineageV1 | null): RootContinuityMarker | null {
  const head = headSession(lineage);
  if (!head?.seededFrom) return null;
  const previous = lineage!.sessions.find((session) => session.conversationId === head.seededFrom);
  return {
    previousConversationId: head.seededFrom,
    previousPath: previous?.path ?? null,
    reason: head.reason ?? "rollover",
    at: head.startedAt,
  };
}

function trim(sessions: RootSessionV1[]): RootSessionV1[] {
  return sessions.length > MAX_ROOT_SESSIONS ? sessions.slice(sessions.length - MAX_ROOT_SESSIONS) : sessions;
}

function bump(lineage: RootLineageV1, sessions: RootSessionV1[], now: Date): RootLineageV1 {
  return { ...lineage, revision: lineage.revision + 1, updatedAt: now.toISOString(), sessions: trim(sessions) };
}

export function emptyRootLineage(rootId: string, now: Date): RootLineageV1 {
  return { schemaVersion: ROOT_LINEAGE_SCHEMA_VERSION, rootId, revision: 0, updatedAt: now.toISOString(), sessions: [] };
}

/**
 * Fold a live root session into the lineage.
 *
 * A conversation id that differs from the current head is a rollover, not an
 * error: D5 expects sessions to be replaced during normal operation. The
 * predecessor is closed out, the successor records what it continues from, and
 * the root id is untouched — which is the whole point, since that id is what
 * in-flight attention requests were written against.
 */
export function adoptRootSession(
  lineage: RootLineageV1 | null,
  candidate: { conversationId: string; path?: string | null },
  options: { now?: Date; rootId?: string; reason?: RootRolloverReason } = {},
): RootAdoption {
  const now = options.now ?? new Date();
  const path = candidate.path ?? null;
  if (!lineage || lineage.sessions.length === 0) {
    const base = lineage ?? emptyRootLineage(options.rootId ?? mintRootId(), now);
    return {
      lineage: bump(base, [{ conversationId: candidate.conversationId, path, startedAt: now.toISOString() }], now),
      outcome: "created",
    };
  }

  const head = lineage.sessions.at(-1)!;
  if (head.conversationId === candidate.conversationId) {
    /* A spawn reports its transcript path only once the engine has written it.
       Recording that arrival is a change; re-reporting the same path is not, so
       an idle heartbeat never churns the revision. */
    if (path === null || head.path === path) return { lineage, outcome: "current" };
    return {
      lineage: bump(lineage, [...lineage.sessions.slice(0, -1), { ...head, path }], now),
      outcome: "settled",
    };
  }

  const successor: RootSessionV1 = {
    conversationId: candidate.conversationId,
    path,
    startedAt: now.toISOString(),
    seededFrom: head.conversationId,
    reason: options.reason ?? "rollover",
  };
  return {
    lineage: bump(lineage, [...lineage.sessions.slice(0, -1), { ...head, endedAt: now.toISOString() }, successor], now),
    outcome: "rolled-over",
  };
}

/** A fresh stable root identity. Opaque on purpose — nothing may parse it. */
export function mintRootId(): string {
  return `root_${crypto.randomUUID()}`;
}
