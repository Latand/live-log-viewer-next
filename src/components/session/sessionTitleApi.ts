"use client";

import type { SessionTitleOverride } from "@/lib/session/titleStore";

/** Fired after any successful rename so `/api/files` pollers refresh at once
    instead of waiting out the 10s cadence. */
export const SESSION_TITLES_CHANGED_EVENT = "llv:session-titles-changed";

export function fireSessionTitlesChanged(): void {
  window.dispatchEvent(new Event(SESSION_TITLES_CHANGED_EVENT));
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
  | { ok: true; override: SessionTitleOverride | null; revision: number }
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
    revision?: number;
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
    return { ok: true, override: json.override ?? null, revision: json.revision ?? 0 };
  }
  return { ok: false, status: res.status, error: json.error ?? "save failed", conflict: json.conflict ?? null };
}
