type MigrationTick = () => Promise<void>;

interface ControllerSignalState {
  tick: MigrationTick | null;
  scheduled: boolean;
}

/* Next route handlers and instrumentation can evaluate this module in
   separate bundle realms. Their shared process object carries the controller
   registration and coalescing state across those evaluations. */
const signalHost = process as typeof process & {
  __llvAccountMigrationSignal?: ControllerSignalState;
};

const signal = signalHost.__llvAccountMigrationSignal ??= { tick: null, scheduled: false };

export function registerAccountMigrationTick(tick: MigrationTick): () => void {
  signal.tick = tick;
  return () => {
    if (signal.tick === tick) signal.tick = null;
  };
}

export function requestAccountMigrationTick(): void {
  if (signal.scheduled || signal.tick === null) return;
  signal.scheduled = true;
  queueMicrotask(() => {
    signal.scheduled = false;
    const tick = signal.tick;
    if (tick === null) return;
    void tick().catch(() => {
      console.error("[account migration controller] requested reconciliation failed");
    });
  });
}
