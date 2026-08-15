import { kyivDayKey, nextDayKey, previousCompleteKyivDay } from "./calculator";
import { upsertOperatorOccurrence } from "./ledger";
import { storeDailyRollup, worktimeSafeError } from "./service";
import type { EditorInterval, OperatorOccurrenceInput, WorktimeStateV1 } from "./types";

export interface HistoricalDayScan {
  complete: boolean;
  reason?: "inventory-incomplete" | "derivation-incomplete" | "transcript-tail-incomplete";
  occurrences: OperatorOccurrenceInput[];
}

export interface WorktimeCatchupDependencies {
  now(): number;
  readState(): WorktimeStateV1;
  scanHistoricalDay(day: string): Promise<HistoricalDayScan>;
  fetchEditorEvidence(day: string): Promise<{ intervals: EditorInterval[]; excludedSyntheticMs: number }>;
  mutate<T>(operation: (state: WorktimeStateV1) => T): T;
  projectPriority: string[];
  stateExists?(): boolean;
}

/**
 * Processes complete Kyiv days in order. Inventory classification completes
 * before credential-backed editor reads and before any state transaction, so
 * an uncertain scan has no side effects and remains retryable.
 */
export async function runWorktimeCatchupPass(dependencies: WorktimeCatchupDependencies): Promise<void> {
  const now = dependencies.now();
  if (dependencies.stateExists && !dependencies.stateExists()) {
    const initialInventory = await dependencies.scanHistoricalDay(kyivDayKey(now));
    if (!initialInventory.complete) return;
    dependencies.mutate(() => undefined);
    return;
  }
  const lastCompleteDay = previousCompleteKyivDay(now);
  let day = kyivDayKey(dependencies.readState().enabledAtMs);
  while (day <= lastCompleteDay) {
    const current = dependencies.readState();
    if (current.rollups[day]?.lifecycle.deliveredAt) {
      day = nextDayKey(day);
      continue;
    }
    const historical = await dependencies.scanHistoricalDay(day);
    if (!historical.complete) return;
    const candidate = structuredClone(current);
    for (const occurrence of historical.occurrences) upsertOperatorOccurrence(candidate, occurrence);
    if (candidate.rollups[day]) {
      day = nextDayKey(day);
      continue;
    }
    let editor: { intervals: EditorInterval[]; excludedSyntheticMs: number };
    try {
      editor = await dependencies.fetchEditorEvidence(day);
    } catch (error) {
      dependencies.mutate((state) => {
        state.catchup.lastAttemptedAt = new Date(now).toISOString();
        state.catchup.failedDay = day;
        state.catchup.lastError = worktimeSafeError(error);
      });
      return;
    }
    dependencies.mutate((state) => {
      if (state.rollups[day]?.lifecycle.deliveredAt) return;
      for (const occurrence of historical.occurrences) upsertOperatorOccurrence(state, occurrence);
      if (state.rollups[day]) return;
      storeDailyRollup(state, day, editor, dependencies.projectPriority, now);
      state.catchup.lastAttemptedAt = new Date(now).toISOString();
      state.catchup.failedDay = null;
      state.catchup.lastError = null;
    });
    day = nextDayKey(day);
  }
}
