/**
 * Which project each return point was captured in (#688 D8).
 *
 * The record's `ReturnPoint` carries mode, camera and focused path but no
 * project, and it must not carry one: return points are per-device, and a
 * project written into the shared record by the device that accepted would be
 * read by every other device's restore. So the capturing device remembers that
 * part itself.
 *
 * It has to be remembered somewhere durable rather than in a component ref. The
 * device id lives in `localStorage` and is therefore shared by every tab in the
 * browser, so a second tab renders the same `following` request and offers the
 * same return control — and a reload of the accepting tab does too. A camera is
 * world coordinates in one project's layout; restoring one into a different
 * project's board lands the operator somewhere arbitrary, which is exactly what
 * the return promise rules out. Storing it beside the device id puts the memory
 * in the same scope as the identity that can act on it.
 *
 * A missing entry is not an error: it means this browser never captured that
 * point, and the restore degrades to the focused path rather than guessing.
 */

const KEY_PREFIX = "llv.attention.return-project.";
/** Return windows are 60s and one request is answered at a time; anything past
    a handful of entries is history nobody can act on. */
const MAX_REMEMBERED = 8;

type Remembered = Record<string, string | null>;

function keyFor(deviceId: string): string {
  return `${KEY_PREFIX}${deviceId}`;
}

function read(storage: Storage | null, deviceId: string | null): Remembered {
  if (!storage || !deviceId) return {};
  try {
    const raw = storage.getItem(keyFor(deviceId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>)
        .filter(([, value]) => value === null || typeof value === "string"),
    ) as Remembered;
  } catch {
    /* Unreadable or unparseable storage is an empty memory, never a throw: the
       return still works, it just cannot restore a camera. */
    return {};
  }
}

function write(storage: Storage | null, deviceId: string | null, value: Remembered): void {
  if (!storage || !deviceId) return;
  try {
    storage.setItem(keyFor(deviceId), JSON.stringify(value));
  } catch {
    /* Private mode, or a full quota. The restore degrades; nothing else does. */
  }
}

/** The project this device was in when it captured the point for `requestId`,
    or null when this browser has no record of capturing it. */
export function readReturnProject(storage: Storage | null, deviceId: string | null, requestId: string): string | null {
  return read(storage, deviceId)[requestId] ?? null;
}

export function rememberReturnProject(
  storage: Storage | null,
  deviceId: string | null,
  requestId: string,
  project: string | null,
): void {
  const current = read(storage, deviceId);
  delete current[requestId];
  const entries = [...Object.entries(current), [requestId, project] as const].slice(-MAX_REMEMBERED);
  write(storage, deviceId, Object.fromEntries(entries) as Remembered);
}

export function forgetReturnProject(storage: Storage | null, deviceId: string | null, requestId: string): void {
  const current = read(storage, deviceId);
  if (!(requestId in current)) return;
  delete current[requestId];
  write(storage, deviceId, current);
}
