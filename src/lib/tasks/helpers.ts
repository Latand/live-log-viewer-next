export function isoNow(): string {
  return new Date().toISOString();
}

export function shortTaskId(id: string): string {
  return id.slice(0, 8);
}

export function firstLineTitle(text: string): string {
  const first = text.split(/\r?\n/, 1)[0]?.trim() ?? "";
  return first || "Untitled";
}

export function taskDeliveryText(id: string, text: string): string {
  return `Task #${shortTaskId(id)}: ${text}`;
}

/** Overdue derives at render only — nothing persists it, so DST and clock skew
    self-heal every frame. A malformed instant is never overdue. */
export function isOverdue(dueAt: string, nowMs = Date.now()): boolean {
  const t = Date.parse(dueAt);
  return Number.isFinite(t) && t < nowMs;
}

/** Compact chip label for a deadline, formatted in the zone it was set in
    (`dueTz`). Falls back to the viewer's zone if `dueTz` is somehow invalid. */
export function formatDue(dueAt: string, dueTz: string, locale = "en"): string {
  const d = new Date(dueAt);
  if (Number.isNaN(d.getTime())) return "";
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" };
  try {
    return new Intl.DateTimeFormat(locale, { ...opts, timeZone: dueTz }).format(d);
  } catch {
    return new Intl.DateTimeFormat(locale, opts).format(d);
  }
}

/** UTC instant → a `datetime-local` field value in the browser's local zone,
    for editing an existing deadline. */
export function toDueInputValue(dueAt: string): string {
  const d = new Date(dueAt);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A `datetime-local` value (browser local zone) → the canonical UTC instant
    plus the IANA zone captured at set time. Returns null for an unparseable value. */
export function fromDueInput(value: string): { dueAt: string; dueTz: string } | null {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return { dueAt: new Date(ms).toISOString(), dueTz: Intl.DateTimeFormat().resolvedOptions().timeZone };
}
