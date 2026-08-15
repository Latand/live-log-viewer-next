export const WORKTIME_TIMEZONE = "Europe/Kyiv" as const;

export type OperatorEventOrigin = "composer" | "realtime" | "api-human" | "historical";
export type OperatorEventRelation = "direct" | "copy";

export interface OperatorEventProvenance {
  id: string;
  origin: Exclude<OperatorEventOrigin, "historical">;
  relation: OperatorEventRelation;
}

export interface OperatorProjectCandidate {
  rank: number;
  evidenceDigests: string[];
}

export interface CanonicalOperatorEvent {
  id: string;
  sourceDigest: string;
  origin: OperatorEventOrigin;
  occurredAtMs: number;
  provenOperator: boolean;
  project: string | null;
  ambiguous: boolean;
  projectCandidates: Record<string, OperatorProjectCandidate>;
  occurrenceDigests: string[];
  occurrenceCount: number;
  deduplicatedCount: number;
  evidenceDigests: string[];
  historical?: {
    contentDigest: string;
    lineageDigest: string;
  };
}

export interface EditorInterval {
  project: string | null;
  startMs: number;
  endMs: number;
  evidenceDigest: string;
}

export interface WorktimeIntervalBoundary {
  startMs: number;
  endMs: number;
}

export interface DailyProjectRollup {
  project: string;
  intervals: WorktimeIntervalBoundary[];
  rawMinutes: number;
  roundedHours: number;
  operatorEventCount: number;
  editorIntervalCount: number;
  evidenceCount: number;
  deduplicatedCount: number;
}

export interface DailyWorktimeRollup {
  day: string;
  timezone: typeof WORKTIME_TIMEZONE;
  projects: DailyProjectRollup[];
  rawMinutes: number;
  roundedHours: number;
  operatorEventCount: number;
  editorIntervalCount: number;
  evidenceCount: number;
  deduplicatedCount: number;
  excludedSyntheticMinutes: number;
  ambiguousMinutes: number;
  ambiguousEvidenceCount: number;
  ambiguousIntervals: WorktimeIntervalBoundary[];
}

export interface WorktimeDeliveryLifecycle {
  calculatedAt: string;
  draftedAt: string | null;
  deliveryAttemptedAt: string | null;
  deliveredAt: string | null;
  destination: "private-draft";
  receiptId: string | null;
  lastError: string | null;
  payloadDigest: string;
}

export interface StoredDailyRollup {
  rollup: DailyWorktimeRollup;
  lifecycle: WorktimeDeliveryLifecycle;
}

export interface ModelFreeDailyWorktimeExport {
  rollup: DailyWorktimeRollup;
  lifecycle: {
    calculated_at: string;
    drafted_at: string | null;
    delivery_attempted_at: string | null;
    delivered_at: string | null;
    destination: "private-draft";
    receipt_id: string | null;
    last_error: string | null;
    payload_digest: string;
  };
}

export interface WorktimeStateV1 {
  version: 1;
  enabledAtMs: number;
  events: Record<string, CanonicalOperatorEvent>;
  rollups: Record<string, StoredDailyRollup>;
  catchup: {
    lastAttemptedAt: string | null;
    failedDay: string | null;
    lastError: string | null;
  };
}

export interface OperatorOccurrenceInput {
  sourceId?: string;
  occurrenceId: string;
  origin: OperatorEventOrigin;
  relation: OperatorEventRelation;
  occurredAtMs: number;
  projectCandidates: Array<{ project: string; rank: number; evidence: string }>;
  historical?: {
    contentDigest: string;
    lineageDigest: string;
  };
}
