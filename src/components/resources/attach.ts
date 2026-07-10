import { copyText } from "@/components/feed/CopyButton";
import type { MessageKey } from "@/lib/i18n";

/** Full attach lets the user drive the pane; read-only mirrors it view-only. */
export type AttachKind = "attach" | "readonly";

/** Machine-readable failure reasons the row maps to localized copy. The three
    endpoint reasons (`stale-pane`, `server-restarted`, `tmux-unavailable`) come
    straight from the server; `bad-request`, `network`, and `clipboard` are the
    client-side failures the fetch/copy round-trip can add. */
export type AttachReason =
  | "stale-pane"
  | "server-restarted"
  | "tmux-unavailable"
  | "bad-request"
  | "network"
  | "clipboard";

/** Shape of the same-origin `?attach=1` response (both success and error). We
    read defensively — the row never trusts the payload's own English text. */
export interface AttachApiBody {
  attach?: { target?: string; command?: string; readOnlyCommand?: string };
  reason?: string;
}

export type AttachResult = { ok: true; command: string } | { ok: false; reason: AttachReason };

/** Live per-row state the view renders; `kind` remembers which button fired so
    the confirmation names the right command. */
export type AttachStatus =
  | { phase: "loading"; kind: AttachKind }
  | { phase: "copied"; kind: AttachKind }
  | { phase: "error"; kind: AttachKind; reason: AttachReason };

export function attachUrl(target: string): string {
  return `/api/tmux?attach=1&target=${encodeURIComponent(target)}`;
}

/** Pick the requested command out of a 200 body, or null when the field the
    kind needs is missing/empty (a malformed success we treat as unavailable). */
export function pickCommand(kind: AttachKind, body: AttachApiBody): string | null {
  const command = kind === "readonly" ? body.attach?.readOnlyCommand : body.attach?.command;
  return typeof command === "string" && command.length > 0 ? command : null;
}

/** Map an HTTP status + parsed body to a resolution, before any clipboard
    write. The server's `reason` wins when present (409 stale/restart, 503
    unavailable); a 400 with no known reason is a bad request. */
export function resolveAttach(kind: AttachKind, status: number, body: AttachApiBody): AttachResult {
  if (status === 200) {
    const command = pickCommand(kind, body);
    return command ? { ok: true, command } : { ok: false, reason: "tmux-unavailable" };
  }
  if (body.reason === "stale-pane" || body.reason === "server-restarted" || body.reason === "tmux-unavailable") {
    return { ok: false, reason: body.reason };
  }
  return { ok: false, reason: status === 400 ? "bad-request" : "tmux-unavailable" };
}

/** A failure the user can clear by re-polling the resource snapshot (which
    re-resolves the pane or drops a vanished row). Bad-request/clipboard are not
    fixed by a refresh, so they get no Refresh action. */
export function isRecoverable(reason: AttachReason): boolean {
  return reason === "stale-pane" || reason === "server-restarted" || reason === "tmux-unavailable";
}

/** Localized message key for a failure reason. */
export function reasonKey(reason: AttachReason): MessageKey {
  switch (reason) {
    case "stale-pane":
      return "attach.stale";
    case "server-restarted":
      return "attach.restarted";
    case "tmux-unavailable":
      return "attach.unavailable";
    case "bad-request":
      return "attach.badRequest";
    case "network":
      return "attach.network";
    case "clipboard":
      return "attach.clipboard";
  }
}

/** Localized "copied" confirmation key, keyed to which command was copied. */
export function copiedKey(kind: AttachKind): MessageKey {
  return kind === "readonly" ? "attach.copiedReadonly" : "attach.copied";
}

interface AttachDeps {
  fetch?: typeof fetch;
  copy?: (text: string) => Promise<boolean>;
}

/** One click-time round-trip: resolve the command freshly (never cached), then
    copy it. The command string is used only to hand to the clipboard — nothing
    keeps it, so a later paste always reflects a re-resolved endpoint/target.
    Every branch resolves to an {@link AttachResult}; the caller renders state. */
export async function performAttachCopy(target: string, kind: AttachKind, deps: AttachDeps = {}): Promise<AttachResult> {
  const doFetch = deps.fetch ?? fetch;
  const doCopy = deps.copy ?? copyText;
  let response: Response;
  try {
    response = await doFetch(attachUrl(target), { headers: { accept: "application/json" }, cache: "no-store" });
  } catch {
    return { ok: false, reason: "network" };
  }
  let body: AttachApiBody = {};
  try {
    body = (await response.json()) as AttachApiBody;
  } catch {
    /* An unparseable body still carries a status; resolveAttach handles it. */
  }
  const resolved = resolveAttach(kind, response.status, body);
  if (!resolved.ok) return resolved;
  const copied = await doCopy(resolved.command);
  return copied ? resolved : { ok: false, reason: "clipboard" };
}
