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
  /** Set when a `spawn:<launchId>` scope path resolved to this conversation's
      materialized transcript (#342): the original requested path. */
  resolvedFrom?: string;
  text?: { messages: Array<{ role: "user" | "assistant"; at: string | null; text: string }>; truncated: boolean; scannedBytes: number; error?: "unavailable" };
}

/** Typed unresolved `spawn:<launchId>` scope path (#342): the launch receipt
    exists but its conversation has no scanned transcript yet, so the snapshot
    reports the durable launch state instead of silently omitting the path. */
export interface SnapshotSpawnStub {
  path: string;
  kind: "spawn-stub";
  launch: {
    launchId: string;
    state: "starting" | "pane-bound" | "host-verified" | "prompt-delivered" | "path-pending" | "completed" | "failed" | "conflicted";
    error: string | null;
    retrySafe: boolean;
    engine: Extract<Engine, "claude" | "codex">;
    cwd: string;
    createdAt: string;
  };
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
  /** Additive (#342): unresolved spawn placeholders in scope. `truncated` and
      `omittedCount` then cover only genuine budget truncation. */
  stubs: SnapshotSpawnStub[];
  siblings: { selfResolution: "matched" | "unmatched" | "omitted"; agents: Array<{ transcriptPath: string; engine: "claude" | "codex"; project: string | null; title: string | null; activity: string | null; pid: number; self: boolean }> };
  scanner: { scannedAt: string; ageMs: number; durationMs: number; entryCount: number };
}

export interface BoardProjectStateV1 {
  schemaVersion: 1;
  revision: number;
  updatedAt: string;
  pathAliases?: Record<string, string>;
  explicitManual?: string[];
  prefs: {
    manual: string[];
    hidden: string[];
    expanded: string[];
    favorites: string[];
    /* Identity-keyed engine-native subagent tray intent (issue #142 S2). Kept
       apart from the path-keyed lists so they survive a resume that mints a new
       transcript path (like `favorites`): the fold pin is a child conversation
       identity, the tray-disclosure pin a parent conversation identity. Optional
       because legacy board files omit both; the store defaults them to empty. */
    foldedEngineChildIds?: string[];
    expandedEngineTrayParentIds?: string[];
    viewMode: "scheme" | "list" | null;
    taskPanelOpen: boolean;
  };
}

export interface BoardFileV1 { projects: Record<string, BoardProjectStateV1> }
