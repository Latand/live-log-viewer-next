import type { Activity, Engine, FileEntry } from "@/lib/types";

export const VIEW_SCHEMA_VERSION = 1 as const;
export const MAX_PRESENCE_BYTES = 32 * 1024;
export const MAX_VISIBLE_PATHS = 128;
export const MAX_SELECTED_PATHS = 64;
export const MAX_SCOPE_PATHS = 16;
export const MAX_RESPONSE_BYTES = 96 * 1024;
export const MAX_TEXT_BYTES = 32 * 1024;

export type ViewMode = "overview" | "scheme" | "list" | "mobile-focus" | "mobile-map";
export type DeviceKind = "desktop" | "tablet" | "mobile";
export type BrowserKind = "chrome" | "firefox" | "safari" | "other";
export type ViewFreshness = "active" | "background" | "stale";
export type ViewScopeKind = "focused" | "selected" | "visible" | "focused-selected" | "paths";

export interface PresencePayloadV1 {
  schemaVersion: 1;
  viewSessionId: string;
  deviceId: string;
  device: { kind: DeviceKind; browser: BrowserKind };
  visibility: "visible" | "hidden";
  sequence: number;
  inputSequence: number;
  project: string | null;
  mode: ViewMode;
  viewport: { width: number; height: number; dpr: number };
  camera: { x: number; y: number; zoom: number; worldRect: { x: number; y: number; width: number; height: number } } | null;
  focusedPath: string | null;
  selectedPaths: string[];
  visiblePaths: string[];
  board: { renderedRevision: number | null; durableRevision: number | null; sync: "current" | "pending" | "stale" | "unavailable" };
}

export interface StoredViewSession extends PresencePayloadV1 {
  lastSeenAt: number;
  lastInteractionAt: number;
}

export interface ViewSessionSummary {
  viewSessionId: string;
  deviceId: string;
  device: PresencePayloadV1["device"];
  visibility: PresencePayloadV1["visibility"];
  freshness: ViewFreshness;
  presenceAgeMs: number;
  lastSeenAt: string;
  lastInteractionAt: string;
  project: string | null;
  mode: ViewMode;
}

export interface SnapshotRequestV1 {
  schemaVersion: 1;
  view?: { id?: string; deviceId?: string; resolution?: "latest-interaction" | "require-explicit" };
  scope?: { kind: ViewScopeKind; paths?: string[] };
  text?: { include?: boolean; lastMessages?: number; maxCharsPerConversation?: number };
  caller?: { pid?: number; transcriptPath?: string };
}

export interface SnapshotConversation {
  path: string;
  project: string;
  title: string;
  engine: Extract<Engine, "claude" | "codex">;
  model: string | null;
  activity: Activity;
  proc: FileEntry["proc"];
  attention: { state: "question" | "terminal" | "stalled"; since: string } | null;
  text?: { messages: Array<{ role: "user" | "assistant"; at: string | null; text: string }>; truncated: boolean; scannedBytes: number; error?: "unavailable" };
}

export interface ViewerSnapshotV1 {
  ok: true;
  schemaVersion: 1;
  capability: "viewer.snapshot";
  generatedAt: string;
  resolution: { by: "explicit" | "latest-interaction" | "only-eligible"; ambiguous: boolean; alternatives: ViewSessionSummary[] };
  view: Omit<PresencePayloadV1, "schemaVersion" | "sequence" | "inputSequence"> & { freshness: ViewFreshness; presenceAgeMs: number };
  scope: { kind: ViewScopeKind; totalPaths: number; returnedPaths: string[]; truncated: boolean; omittedCount: number };
  conversations: SnapshotConversation[];
  siblings: { selfResolution: "matched" | "unmatched" | "omitted"; agents: Array<{ transcriptPath: string; engine: "claude" | "codex"; project: string | null; title: string | null; activity: string | null; pid: number; self: boolean }> };
  scanner: { scannedAt: string; ageMs: number; durationMs: number; entryCount: number };
}

export interface BoardProjectStateV1 {
  schemaVersion: 1;
  revision: number;
  updatedAt: string;
  pathAliases?: Record<string, string>;
  explicitManual?: string[];
  prefs: { manual: string[]; hidden: string[]; expanded: string[]; favorites: string[]; viewMode: "scheme" | "list" | null; taskPanelOpen: boolean };
}

export interface BoardFileV1 { projects: Record<string, BoardProjectStateV1> }
