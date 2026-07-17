import { tickPipelines } from "./engine";

type PipelineTick = () => Promise<void>;

interface PipelineSignalState {
  tick: PipelineTick | null;
  scheduled: boolean;
}

const signalHost = globalThis as typeof globalThis & {
  __llvPipelineSignal?: PipelineSignalState;
};

async function defaultPipelineTick(): Promise<void> {
  await tickPipelines([]);
  await tickPipelines([]);
}

const signal = signalHost.__llvPipelineSignal ??= { tick: defaultPipelineTick, scheduled: false };

export function registerPipelineTick(tick: PipelineTick): () => void {
  const previous = signal.tick;
  signal.tick = tick;
  return () => {
    if (signal.tick === tick) signal.tick = previous;
  };
}

export function requestPipelineTick(): void {
  if (signal.scheduled || signal.tick === null) return;
  signal.scheduled = true;
  queueMicrotask(() => {
    signal.scheduled = false;
    const tick = signal.tick;
    if (tick === null) return;
    void tick().catch(() => {
      console.error("[pipeline controller] requested tick failed");
    });
  });
}
