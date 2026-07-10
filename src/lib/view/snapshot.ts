import type { FileEntry } from "@/lib/types";

import { compactText } from "./compactText";
import { freshness, listPresence, sessionSummary } from "./presenceStore";
import { MAX_RESPONSE_BYTES, MAX_SCOPE_PATHS, MAX_TEXT_BYTES, type SnapshotConversation, type SnapshotRequestV1, type StoredViewSession, type ViewerSnapshotV1, type ViewScopeKind, type ViewSessionSummary } from "./types";

type SnapshotErrorCode = "NO_ACTIVE_VIEW" | "VIEW_SESSION_NOT_FOUND" | "AMBIGUOUS_ACTIVE_VIEW" | "PATH_OUTSIDE_CURRENT_VIEW" | "INTERNAL_ERROR";
export class SnapshotError extends Error {
  constructor(readonly code: SnapshotErrorCode, readonly status: number, message: string, readonly sessions?: ViewSessionSummary[]) { super(message); }
}

interface Selection { session: StoredViewSession; by: ViewerSnapshotV1["resolution"]["by"]; alternatives: StoredViewSession[]; ambiguous: boolean }
function choose(request: SnapshotRequestV1, now: number): Selection {
  const retained = listPresence(now);
  const id = request.view?.id;
  const deviceId = request.view?.deviceId;
  if (id) {
    const selected = retained.find((session) => session.viewSessionId === id && (!deviceId || session.deviceId === deviceId));
    if (!selected) throw new SnapshotError("VIEW_SESSION_NOT_FOUND", 404, "view session not found");
    return { session: selected, by: "explicit", alternatives: retained.filter((session) => session.viewSessionId !== selected.viewSessionId), ambiguous: false };
  }

  const filtered = deviceId ? retained.filter((session) => session.deviceId === deviceId) : retained;
  const foreground = filtered.filter((session) => freshness(session, now) === "active");
  const background = filtered.filter((session) => freshness(session, now) === "background");
  const candidates = foreground.length > 0 ? foreground : background;
  if (candidates.length === 0) throw new SnapshotError("NO_ACTIVE_VIEW", 404, "no active view");
  const selected = candidates[0]!;
  const second = candidates[1];
  const ambiguous = Boolean(second && Math.abs(selected.lastInteractionAt - second.lastInteractionAt) <= 30_000);
  if (ambiguous && request.view?.resolution === "require-explicit") {
    throw new SnapshotError("AMBIGUOUS_ACTIVE_VIEW", 409, "active view is ambiguous", candidates.map((session) => sessionSummary(session, now)));
  }
  return {
    session: selected,
    by: deviceId ? "explicit" : candidates.length === 1 ? "only-eligible" : "latest-interaction",
    alternatives: retained.filter((session) => session.viewSessionId !== selected.viewSessionId),
    ambiguous,
  };
}

function scopedPaths(session: StoredViewSession, scope: SnapshotRequestV1["scope"]): { kind: ViewScopeKind; all: string[] } {
  const kind = scope?.kind ?? "focused-selected";
  const focus = session.focusedPath ? [session.focusedPath] : [];
  const selected = session.selectedPaths;
  const values = kind === "focused" ? focus : kind === "selected" ? selected : kind === "visible" ? session.visiblePaths : kind === "paths" ? (scope?.paths ?? []) : [...focus, ...selected.filter((path) => path !== session.focusedPath)];
  return { kind, all: values };
}

function validateExplicitMembership(session: StoredViewSession, explicit: readonly string[]): void {
  const currentView = new Set([session.focusedPath, ...session.selectedPaths, ...session.visiblePaths].filter((value): value is string => value !== null));
  if (explicit.some((pathname) => !currentView.has(pathname))) throw new SnapshotError("PATH_OUTSIDE_CURRENT_VIEW", 422, "path is outside current view");
}

function transcriptEntry(byPath: ReadonlyMap<string, FileEntry>, pathname: string): FileEntry | undefined {
  const entry = byPath.get(pathname);
  return entry?.engine === "claude" || entry?.engine === "codex" ? entry : undefined;
}

function conversation(entry: FileEntry): SnapshotConversation {
  const attention = entry.pendingQuestion ? { state: "question" as const, since: entry.pendingQuestion.askedAt } : entry.waitingInput ? { state: "terminal" as const, since: new Date(entry.waitingInput.since * 1000).toISOString() } : entry.activity === "stalled" ? { state: "stalled" as const, since: new Date(entry.mtime * 1000).toISOString() } : null;
  return { path: entry.path, project: entry.project, title: entry.title, engine: entry.engine as "claude" | "codex", model: entry.model, activity: entry.activity, proc: entry.proc, attention };
}

export async function composeSnapshot(input: { request: SnapshotRequestV1; files: FileEntry[]; scannerDurationMs: number; siblings: ViewerSnapshotV1["siblings"]; now?: number }): Promise<ViewerSnapshotV1> {
  const now = input.now ?? Date.now();
  const selection = choose(input.request, now);
  const session = selection.session;
  const byPath = new Map(input.files.map((file) => [file.path, file]));
  const requestedPaths = input.request.scope?.kind === "paths" ? input.request.scope.paths ?? [] : [];
  validateExplicitMembership(session, requestedPaths);
  const scope = scopedPaths(session, input.request.scope);
  const returnedPaths = scope.all.filter((pathname) => transcriptEntry(byPath, pathname)).slice(0, MAX_SCOPE_PATHS);
  let textRemaining = MAX_TEXT_BYTES;
  const conversations = returnedPaths.map((pathname) => {
    const entry = transcriptEntry(byPath, pathname);
    if (!entry) throw new SnapshotError("INTERNAL_ERROR", 500, "snapshot membership changed during composition");
    const card = conversation(entry);
    if (input.request.text?.include !== false) {
      const text = compactText(entry, input.request.text?.lastMessages ?? 6, input.request.text?.maxCharsPerConversation ?? 3000, textRemaining);
      textRemaining -= text.messages.reduce((total, message) => total + Buffer.byteLength(message.text, "utf8"), 0);
      card.text = text;
    }
    return card;
  });
  const omittedCount = scope.all.length - returnedPaths.length;
  const snapshot: ViewerSnapshotV1 = {
    ok: true, schemaVersion: 1, capability: "viewer.snapshot", generatedAt: new Date(now).toISOString(),
    resolution: { by: selection.by, ambiguous: selection.ambiguous, alternatives: selection.alternatives.map((item) => sessionSummary(item, now)) },
    view: { viewSessionId: session.viewSessionId, deviceId: session.deviceId, device: session.device, visibility: session.visibility, freshness: freshness(session, now), presenceAgeMs: Math.max(0, now - session.lastSeenAt), project: session.project, mode: session.mode, viewport: session.viewport, camera: session.camera, focusedPath: session.focusedPath, selectedPaths: session.selectedPaths, visiblePaths: session.visiblePaths, board: session.board },
    scope: { kind: scope.kind, totalPaths: scope.all.length, returnedPaths, truncated: omittedCount > 0, omittedCount },
    conversations, siblings: input.siblings,
    scanner: { scannedAt: new Date(now).toISOString(), ageMs: 0, durationMs: input.scannerDurationMs, entryCount: input.files.length },
  };
  if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > MAX_RESPONSE_BYTES) throw new SnapshotError("INTERNAL_ERROR", 500, "snapshot response limit exceeded");
  return snapshot;
}
