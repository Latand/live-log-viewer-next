export type ResourceDegradedReason = "collector-busy" | "timeout" | "collector-crash";

export type ResourceObservation<T> = Readonly<{
  generation: number;
  startedAt: number;
  completedAt: number;
  collectorId: string;
  value: T;
  degradedReason?: ResourceDegradedReason;
}>;

export interface ResourceCollector<T> {
  latest(): ResourceObservation<T> | null;
  fence(): number;
  observe(fence: number, timeoutMs: number): Promise<ResourceObservation<T> | null>;
}

export type ResourceCollectorOptions<T> = {
  collectorId: string;
  collect(): Promise<T>;
  now?(): number;
  initial?: ResourceObservation<T> | null;
};

function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
  }
  return value;
}

function withDegradedReason<T>(
  observation: ResourceObservation<T>,
  degradedReason: ResourceDegradedReason,
): ResourceObservation<T> {
  return freeze({ ...observation, degradedReason });
}

/**
 * Generation-fenced observation collector. Its interface keeps request paths
 * independent of collection mechanics: an adapter may gather in-process for
 * rollback or isolate the same work in a worker.
 */
export function createResourceCollector<T>(options: ResourceCollectorOptions<T>): ResourceCollector<T> {
  const now = options.now ?? Date.now;
  let startedGeneration = options.initial?.generation ?? 0;
  let latest: ResourceObservation<T> | null = options.initial ?? null;
  let active: { generation: number; promise: Promise<ResourceObservation<T>> } | null = null;

  const launch = (): Promise<ResourceObservation<T>> => {
    const generation = ++startedGeneration;
    const startedAt = now();
    const promise = Promise.resolve()
      .then(options.collect)
      .then((value) => freeze({
        generation,
        startedAt,
        completedAt: now(),
        collectorId: options.collectorId,
        value: freeze(value),
      }));
    const operation = { generation, promise };
    active = operation;
    void promise.then(
      (observation) => {
        if (active === operation) active = null;
        if (!latest || observation.generation > latest.generation) latest = observation;
      },
      () => {
        if (active === operation) active = null;
      },
    );
    return promise;
  };

  const afterFence = (fence: number): Promise<ResourceObservation<T>> => {
    const current = active;
    if (!current) return launch();
    if (current.generation > fence) return current.promise;
    return current.promise.catch(() => undefined).then(() => {
      const next = active;
      return next && next.generation > fence ? next.promise : launch();
    });
  };

  return {
    latest: () => latest,
    fence: () => startedGeneration,
    async observe(fence, timeoutMs) {
      const observation = afterFence(fence);
      const bounded = Math.max(0, timeoutMs);
      if (bounded === 0) {
        void observation.catch(() => undefined);
        return latest ? withDegradedReason(latest, "collector-busy") : null;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          observation,
          new Promise<ResourceObservation<T> | null>((resolve) => {
            timer = setTimeout(() => resolve(latest ? withDegradedReason(latest, "timeout") : null), bounded);
          }),
        ]);
      } catch {
        return latest ? withDegradedReason(latest, "collector-crash") : null;
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}
