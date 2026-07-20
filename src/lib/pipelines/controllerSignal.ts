type PipelineTick = () => Promise<void>;
type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface PipelineSignalState {
  tick: PipelineTick | null;
  scheduled: boolean;
}

const signalHost = globalThis as typeof globalThis & {
  __llvPipelineSignal?: PipelineSignalState;
};

export async function requestRemotePipelineTick(
  fetcher: Fetcher = fetch,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const baseUrl = env.LLV_VIEWER_CONTROL_URL?.trim() || "http://127.0.0.1:8898";
  const response = await fetcher(new URL("/api/pipelines/tick", baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: baseUrl,
      "sec-fetch-site": "same-origin",
    },
    body: "{}",
  });
  if (!response.ok) throw new Error(`pipeline controller request failed with status ${response.status}`);
}

async function defaultPipelineTick(): Promise<void> {
  await requestRemotePipelineTick();
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
