import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";

import type { PresencePayloadV1, StoredViewSession, ViewFreshness, ViewSessionSummary } from "./types";

/**
 * Who is looking at the viewer right now.
 *
 * The map used to live in this process's memory and nowhere else, which made it
 * invisible to every OTHER process on the machine. Only the Next server ever
 * receives a presence heartbeat (`POST /api/view/presence`), so anything asking
 * "is a desktop view open?" from outside that server — the MCP stdio server,
 * most of all, which is a separate process — read an empty map and concluded
 * nobody was there while the operator was sitting in front of the board. That
 * is what `operator_snapshot` reported as `NO_ACTIVE_VIEW`, and what left every
 * attention request's `offeredTo` empty.
 *
 * So presence is mirrored to the shared state dir, the same place the attention
 * record already lives, and every read merges the file in. Memory stays the fast
 * path for the process that owns the heartbeat; the file is what makes the
 * answer the same for everyone else on the machine.
 *
 * Written by temp-and-rename with no lock, deliberately: presence is a
 * best-effort observation with a 25-second freshness window and one writer
 * (the HTTP route). A reader sees either the whole previous file or the whole
 * next one, and a lost race is corrected by the next heartbeat ten seconds
 * later — which is a far better trade than taking a file lock twice a second.
 */

const ACTIVE_MS = 25_000;
const RETENTION_MS = 120_000;
const CAPACITY = 32;

/** Schema of the mirrored file. Bumped only if the stored shape changes. */
const PRESENCE_SCHEMA_VERSION = 1;

interface PresenceFileV1 {
  schemaVersion: number;
  updatedAt: string;
  sessions: StoredViewSession[];
}

type Store = Map<string, StoredViewSession>;
const globals = globalThis as unknown as { __llvViewPresence?: Store };
function store(): Store { return (globals.__llvViewPresence ??= new Map()); }

export function presenceFile(): string {
  return statePath("view-presence.json");
}

function isStoredSession(value: unknown): value is StoredViewSession {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const session = value as Partial<StoredViewSession>;
  return typeof session.viewSessionId === "string" && session.viewSessionId.length > 0
    && typeof session.deviceId === "string"
    && (session.visibility === "visible" || session.visibility === "hidden")
    && typeof session.sequence === "number"
    && typeof session.lastSeenAt === "number"
    && typeof session.lastInteractionAt === "number";
}

/** The mirrored sessions, or nothing at all when the file is missing or has
    been corrupted. Presence is an observation, so an unreadable mirror degrades
    to "this process knows only what it was told" rather than throwing into a
    heartbeat or a snapshot. */
function readMirror(): StoredViewSession[] {
  let text: string;
  try {
    text = fs.readFileSync(presenceFile(), "utf8");
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(text) as Partial<PresenceFileV1>;
    if (parsed.schemaVersion !== PRESENCE_SCHEMA_VERSION || !Array.isArray(parsed.sessions)) return [];
    return parsed.sessions.filter(isStoredSession);
  } catch {
    return [];
  }
}

function writeMirror(sessions: Iterable<StoredViewSession>, now: number): void {
  const file: PresenceFileV1 = {
    schemaVersion: PRESENCE_SCHEMA_VERSION,
    updatedAt: new Date(now).toISOString(),
    sessions: [...sessions],
  };
  const target = presenceFile();
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(temp, JSON.stringify(file, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temp, target);
  } catch {
    /* A presence mirror that cannot be written must never fail the heartbeat
       the operator's browser is sending, nor the snapshot someone is reading.
       The in-memory map is still correct for this process. */
    fs.rmSync(temp, { force: true });
  }
}

/**
 * This process's map, brought up to date with the mirror.
 *
 * Merged by `sequence`, which the browser makes monotonic per view session, so
 * folding the file in is idempotent and can only move a session forward. That
 * is what lets a reader in another process see the operator's live view without
 * any of them having to agree on who owns the map.
 */
function sessions(now: number): Store {
  const current = store();
  for (const mirrored of readMirror()) {
    const held = current.get(mirrored.viewSessionId);
    if (!held || mirrored.sequence > held.sequence) current.set(mirrored.viewSessionId, mirrored);
  }
  expire(now, current);
  return current;
}

export function freshness(session: StoredViewSession, now = Date.now()): ViewFreshness {
  const age = Math.max(0, now - session.lastSeenAt);
  if (session.visibility === "visible") return age < ACTIVE_MS ? "active" : "stale";
  if (age <= RETENTION_MS) return "background";
  return "stale";
}

function expire(now: number, current: Store = store()): void {
  for (const [id, session] of current) if (now - session.lastSeenAt > RETENTION_MS) current.delete(id);
}

function makeRoomForNewSession(current: Store): void {
  while (current.size >= CAPACITY) {
    const oldest = [...current.values()].sort((a, b) => a.lastSeenAt - b.lastSeenAt)[0];
    if (!oldest) break;
    current.delete(oldest.viewSessionId);
  }
}

export function upsertPresence(payload: PresencePayloadV1, now = Date.now()): { accepted: boolean; session: StoredViewSession } {
  const current = sessions(now);
  const held = current.get(payload.viewSessionId);
  if (held && payload.sequence <= held.sequence) return { accepted: false, session: held };
  if (!held) makeRoomForNewSession(current);
  const inputAdvanced = !held || payload.inputSequence > held.inputSequence;
  const session: StoredViewSession = {
    ...payload,
    inputSequence: Math.max(held?.inputSequence ?? 0, payload.inputSequence),
    lastSeenAt: now,
    lastInteractionAt: inputAdvanced ? now : held?.lastInteractionAt ?? now,
  };
  current.set(payload.viewSessionId, session);
  /* Only an accepted heartbeat writes: a replayed or stale sequence changed
     nothing, and re-serializing the same map for it would be pure churn. */
  writeMirror(current.values(), now);
  return { accepted: true, session };
}

export function sessionSummary(session: StoredViewSession, now = Date.now()): ViewSessionSummary {
  return { viewSessionId: session.viewSessionId, deviceId: session.deviceId, device: session.device, visibility: session.visibility, freshness: freshness(session, now), presenceAgeMs: Math.max(0, now - session.lastSeenAt), lastSeenAt: new Date(session.lastSeenAt).toISOString(), lastInteractionAt: new Date(session.lastInteractionAt).toISOString(), project: session.project, mode: session.mode };
}

export function listPresence(now = Date.now()): StoredViewSession[] {
  return [...sessions(now).values()].sort((a, b) => b.lastInteractionAt - a.lastInteractionAt || b.lastSeenAt - a.lastSeenAt || a.viewSessionId.localeCompare(b.viewSessionId));
}

export function resetPresenceForTest(): void {
  globals.__llvViewPresence = new Map();
  try {
    fs.rmSync(presenceFile(), { force: true });
  } catch {
    /* nothing mirrored yet */
  }
}
export const presenceLimits = { ACTIVE_MS, RETENTION_MS, CAPACITY };
