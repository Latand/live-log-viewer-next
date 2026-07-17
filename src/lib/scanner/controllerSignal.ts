type FileControllerTick = () => Promise<void>;

interface FileControllerSignalState {
  tick: FileControllerTick | null;
  scheduled: boolean;
}

const signalHost = globalThis as typeof globalThis & {
  __llvFileControllerSignal?: FileControllerSignalState;
};

const signal = signalHost.__llvFileControllerSignal ??= { tick: null, scheduled: false };

export function registerFileControllerTick(tick: FileControllerTick): () => void {
  signal.tick = tick;
  return () => {
    if (signal.tick === tick) signal.tick = null;
  };
}

export function requestFileControllerTick(): void {
  if (signal.scheduled || signal.tick === null) return;
  signal.scheduled = true;
  queueMicrotask(() => {
    signal.scheduled = false;
    const tick = signal.tick;
    if (tick === null) return;
    void tick().catch(() => {
      console.error("[file controller] requested reconciliation failed");
    });
  });
}
