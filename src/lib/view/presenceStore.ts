import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";
import { canonicalProject } from "@/lib/projects/aliases";

import { VIEW_SCHEMA_VERSION, type PresencePayloadV1, type StoredViewSession, type ViewFreshness, type ViewSessionSummary } from "./types";

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

/** How far ahead of this clock a mirrored timestamp may sit before the entry is
    treated as untrustworthy rather than as merely early. Two machines sharing a
    state dir disagree by a little; a session claiming a future far past that is
    not a clock skew, it is a record nobody should be believing. */
const CLOCK_SKEW_MS = 5_000;

const DEVICE_KINDS = new Set(["desktop", "tablet", "mobile"]);
const BROWSER_KINDS = new Set(["chrome", "firefox", "safari", "other"]);
const VIEW_MODES = new Set(["overview", "scheme", "list", "mobile-focus", "mobile-map"]);
const BOARD_SYNC = new Set(["current", "pending", "stale", "unavailable"]);

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringOrNull(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function stringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function numberOrNull(value: unknown): boolean {
  return value === null || finiteNumber(value);
}

function validDevice(value: unknown): boolean {
  const device = object(value);
  return device !== null
    && typeof device.kind === "string" && DEVICE_KINDS.has(device.kind)
    && typeof device.browser === "string" && BROWSER_KINDS.has(device.browser);
}

function validViewport(value: unknown): boolean {
  const viewport = object(value);
  return viewport !== null
    && finiteNumber(viewport.width) && finiteNumber(viewport.height) && finiteNumber(viewport.dpr);
}

function validCamera(value: unknown): boolean {
  if (value === null) return true;
  const camera = object(value);
  if (!camera) return false;
  const world = object(camera.worldRect);
  return finiteNumber(camera.x) && finiteNumber(camera.y) && finiteNumber(camera.zoom)
    && world !== null
    && finiteNumber(world.x) && finiteNumber(world.y)
    && finiteNumber(world.width) && finiteNumber(world.height);
}

function validBoard(value: unknown): boolean {
  const board = object(value);
  return board !== null
    && numberOrNull(board.renderedRevision) && numberOrNull(board.durableRevision)
    && typeof board.sync === "string" && BOARD_SYNC.has(board.sync);
}

/**
 * Whether a mirrored entry can be believed, in full and all the way down.
 *
 * Presence answers "is someone watching?", and both ways of being wrong are NOT
 * equal. Reading nothing makes an attention request fail visibly, which is the
 * defect this mirror exists to fix. Reading a session that is not really there
 * makes it succeed silently in front of nobody: the request is marked delivered,
 * the desktop it named does not exist, and nothing ever says so. So a partial
 * record is not a degraded record to be repaired with defaults — it is an
 * untrustworthy one, and it is dropped whole.
 *
 * The nested shape is the part that bites, because a top-level `typeof` sweep
 * makes a record look answered while the fields anyone actually USES are still
 * arbitrary:
 *
 * - `device` is dereferenced unguarded by the offer path — `session.device.kind`
 *   in `followCapableDevices`, which runs inside `request_attention`. A record
 *   without it does not degrade, it throws, and takes the whole tool call down.
 * - `device` present but the rest of the record junk is the worse case, and the
 *   quiet one: the entry is well-formed exactly where the offer looks, so a
 *   desktop that does not exist is advertised as followable and the request is
 *   recorded as offered to it.
 * - a finite number outside the range `Date` can represent still round-trips
 *   through JSON, unlike `NaN`, and reaches `toISOString` in `sessionSummary` —
 *   also on the read path of `request_attention` and `operator_snapshot`.
 * - a FUTURE `lastSeenAt` is the permanent phantom. `freshness` clamps the age
 *   at zero, so the entry reads `active` forever, and `expire` — which needs the
 *   age to exceed retention — can never remove it.
 */
function isStoredSession(value: unknown, now: number): value is StoredViewSession {
  const session = object(value);
  if (!session) return false;
  if (session.schemaVersion !== VIEW_SCHEMA_VERSION) return false;
  if (typeof session.viewSessionId !== "string" || session.viewSessionId.length === 0) return false;
  if (typeof session.deviceId !== "string" || session.deviceId.length === 0) return false;
  if (session.visibility !== "visible" && session.visibility !== "hidden") return false;
  if (typeof session.mode !== "string" || !VIEW_MODES.has(session.mode)) return false;
  if (!stringOrNull(session.project) || !stringOrNull(session.focusedPath)) return false;
  if (!stringArray(session.selectedPaths) || !stringArray(session.visiblePaths)) return false;
  if (!validDevice(session.device)) return false;
  if (!validViewport(session.viewport)) return false;
  if (!validCamera(session.camera)) return false;
  if (!validBoard(session.board)) return false;
  if (!finiteNumber(session.sequence) || !finiteNumber(session.inputSequence)) return false;
  if (!finiteNumber(session.lastSeenAt) || !finiteNumber(session.lastInteractionAt)) return false;
  if (session.lastSeenAt <= 0 || session.lastInteractionAt <= 0) return false;
  if (session.lastSeenAt > now + CLOCK_SKEW_MS) return false;
  if (session.lastInteractionAt > now + CLOCK_SKEW_MS) return false;
  return true;
}

/** The mirrored sessions, or nothing at all when the file is missing or has
    been corrupted. Presence is an observation, so an unreadable mirror degrades
    to "this process knows only what it was told" rather than throwing into a
    heartbeat or a snapshot. */
function readMirror(now: number): StoredViewSession[] {
  let text: string;
  try {
    text = fs.readFileSync(presenceFile(), "utf8");
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(text) as Partial<PresenceFileV1>;
    if (parsed.schemaVersion !== PRESENCE_SCHEMA_VERSION || !Array.isArray(parsed.sessions)) return [];
    return parsed.sessions
      .filter((session): session is StoredViewSession => isStoredSession(session, now))
      .map((session) => ({
        ...session,
        project: session.project ? canonicalProject(session.project) : null,
      }));
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
  for (const [id, held] of current) {
    const project = held.project ? canonicalProject(held.project) : null;
    if (project !== held.project) current.set(id, { ...held, project });
  }
  for (const mirrored of readMirror(now)) {
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
    project: payload.project ? canonicalProject(payload.project) : null,
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
