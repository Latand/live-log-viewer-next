/**
 * Process-local exclusion for the Daily Report's connector read phase.
 *
 * The report source pass is deliberately sequential and can take a minute.
 * Fresh connection polls consult this guard and return the last durable status
 * while `get_me` or source discovery is using the shared connector. A report
 * waits for a health check already in flight. Logout and credential deletion
 * remain lifecycle operations and do not consult it.
 */

const READ_GUARD_KEY = "__llvTelegramConnectorReadGuard" as const;

type ReadGuardState = {
  reportReaders: number;
  healthActive: boolean;
  healthWaiters: Array<() => void>;
};
type ReadGuardHost = typeof globalThis & { [READ_GUARD_KEY]?: ReadGuardState };

function guard(): ReadGuardState {
  const host = globalThis as ReadGuardHost;
  return host[READ_GUARD_KEY] ??= { reportReaders: 0, healthActive: false, healthWaiters: [] };
}

export async function beginTelegramReportReadPhase(): Promise<() => void> {
  const state = guard();
  while (state.healthActive) {
    await new Promise<void>((resolve) => { state.healthWaiters.push(resolve); });
  }
  state.reportReaders += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    state.reportReaders = Math.max(0, state.reportReaders - 1);
  };
}

export function telegramReportReadPhaseActive(): boolean {
  return guard().reportReaders > 0;
}

/** A health check begins only when no report owns the connector. */
export function tryBeginTelegramHealthCheck(): (() => void) | null {
  const state = guard();
  if (state.reportReaders > 0 || state.healthActive) return null;
  state.healthActive = true;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    state.healthActive = false;
    const waiters = state.healthWaiters.splice(0);
    for (const resume of waiters) resume();
  };
}
