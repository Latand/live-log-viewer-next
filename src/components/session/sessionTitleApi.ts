"use client";

import type { SessionTitleOverride } from "@/lib/session/titleStore";

/** Fired after any successful rename so `/api/files` pollers refresh at once
    instead of waiting out the 10s cadence. */
export const SESSION_TITLES_CHANGED_EVENT = "llv:session-titles-changed";

export function fireSessionTitlesChanged(): void {
  window.dispatchEvent(new Event(SESSION_TITLES_CHANGED_EVENT));
}

/** Cross-component "open the rename editor for this session" signal — lets the
    scheme board's F2 open a node's editor without threading a prop through the
    canvas. A short-lived pending entry covers the case where the target
    `SessionTitle` mounts (node expands) *after* the request fires. */
export const SESSION_RENAME_REQUEST_EVENT = "llv:session-rename-request";
const PENDING_RENAME_TTL_MS = 2_000;
const pendingRenames = new Map<string, number>();

export function requestSessionRename(path: string): void {
  pendingRenames.set(path, Date.now() + PENDING_RENAME_TTL_MS);
  window.dispatchEvent(new CustomEvent(SESSION_RENAME_REQUEST_EVENT, { detail: { path } }));
}

/** True once (consuming the entry) when a fresh rename was requested for `path`. */
export function consumePendingRename(path: string): boolean {
  const expiry = pendingRenames.get(path);
  if (expiry === undefined) return false;
  pendingRenames.delete(path);
  return expiry >= Date.now();
}

export interface SaveTitleInput {
  path: string;
  conversationId?: string;
  /** Non-empty sets the override; null/empty clears it back to the auto title. */
  title: string | null;
  /** Revision the editor last saw, for optimistic concurrency. */
  baseRevision: number;
  /** Derived title to stamp on the tmux window on a reset; the set-path window
      name is the server-sanitized stored title. The pane is resolved from the
      session server-side, not from the client. */
  windowName?: string;
}

export type SaveTitleResult =
  | { ok: true; override: SessionTitleOverride | null }
  | { ok: false; status: number; error: string; conflict?: SessionTitleOverride | null };

export async function saveSessionTitle(input: SaveTitleInput): Promise<SaveTitleResult> {
  let res: Response;
  try {
    res = await fetch("/api/session/title", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        path: input.path,
        conversationId: input.conversationId,
        title: input.title,
        baseRevision: input.baseRevision,
        windowName: input.windowName,
      }),
    });
  } catch {
    return { ok: false, status: 0, error: "network" };
  }
  let json: {
    ok?: boolean;
    override?: SessionTitleOverride | null;
    error?: string;
    conflict?: SessionTitleOverride | null;
  };
  try {
    json = (await res.json()) as typeof json;
  } catch {
    return { ok: false, status: res.status, error: "invalid response" };
  }
  if (res.ok && json.ok) {
    fireSessionTitlesChanged();
    return { ok: true, override: json.override ?? null };
  }
  return { ok: false, status: res.status, error: json.error ?? "save failed", conflict: json.conflict ?? null };
}
