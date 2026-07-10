import type { PresencePayloadV1, StoredViewSession, ViewFreshness, ViewSessionSummary } from "./types";

const ACTIVE_MS = 25_000;
const RETENTION_MS = 120_000;
const CAPACITY = 32;

type Store = Map<string, StoredViewSession>;
const globals = globalThis as unknown as { __llvViewPresence?: Store };
function store(): Store { return (globals.__llvViewPresence ??= new Map()); }

export function freshness(session: StoredViewSession, now = Date.now()): ViewFreshness {
  const age = Math.max(0, now - session.lastSeenAt);
  if (session.visibility === "visible") return age < ACTIVE_MS ? "active" : "stale";
  if (age <= RETENTION_MS) return "background";
  return "stale";
}

function expire(now = Date.now()): void {
  const sessions = store();
  for (const [id, session] of sessions) if (now - session.lastSeenAt > RETENTION_MS) sessions.delete(id);
}

function makeRoomForNewSession(): void {
  const sessions = store();
  while (sessions.size >= CAPACITY) {
    const oldest = [...sessions.values()].sort((a, b) => a.lastSeenAt - b.lastSeenAt)[0];
    if (!oldest) break;
    sessions.delete(oldest.viewSessionId);
  }
}

export function upsertPresence(payload: PresencePayloadV1, now = Date.now()): { accepted: boolean; session: StoredViewSession } {
  expire(now);
  const sessions = store();
  const current = sessions.get(payload.viewSessionId);
  if (current && payload.sequence <= current.sequence) return { accepted: false, session: current };
  if (!current) makeRoomForNewSession();
  const inputAdvanced = !current || payload.inputSequence > current.inputSequence;
  const session: StoredViewSession = {
    ...payload,
    inputSequence: Math.max(current?.inputSequence ?? 0, payload.inputSequence),
    lastSeenAt: now,
    lastInteractionAt: inputAdvanced ? now : current?.lastInteractionAt ?? now,
  };
  sessions.set(payload.viewSessionId, session);
  return { accepted: true, session };
}

export function sessionSummary(session: StoredViewSession, now = Date.now()): ViewSessionSummary {
  return { viewSessionId: session.viewSessionId, deviceId: session.deviceId, device: session.device, visibility: session.visibility, freshness: freshness(session, now), presenceAgeMs: Math.max(0, now - session.lastSeenAt), lastSeenAt: new Date(session.lastSeenAt).toISOString(), lastInteractionAt: new Date(session.lastInteractionAt).toISOString(), project: session.project, mode: session.mode };
}

export function listPresence(now = Date.now()): StoredViewSession[] {
  expire(now);
  return [...store().values()].sort((a, b) => b.lastInteractionAt - a.lastInteractionAt || b.lastSeenAt - a.lastSeenAt || a.viewSessionId.localeCompare(b.viewSessionId));
}

export function resetPresenceForTest(): void { globals.__llvViewPresence = new Map(); }
export const presenceLimits = { ACTIVE_MS, RETENTION_MS, CAPACITY };
