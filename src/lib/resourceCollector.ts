export type ResourceDegradedReason = "collector-busy" | "timeout" | "collector-crash";

export type ResourceFailureCause =
  | "collection-active"
  | "observation-timeout"
  | "file-handoff-timeout"
  | "collector-error"
  | "observation-limit"
  | "worker-timeout"
  | "worker-spawn"
  | "worker-exit"
  | "worker-input"
  | "worker-output-limit"
  | "worker-output-invalid"
  | "worker-failure";

export type ResourceFailureDiagnostic = Readonly<{
  cause: ResourceFailureCause;
  message: string;
  causes: readonly string[];
  stderr?: string;
}>;

export type ResourceCollectorFailure = Readonly<{
  reason: ResourceDegradedReason;
  diagnostic: ResourceFailureDiagnostic;
}>;

export type ResourceObservation<T> = Readonly<{
  generation: number;
  startedAt: number;
  completedAt: number;
  collectorId: string;
  value: T;
  degradedReason?: ResourceDegradedReason;
}>;

export type ResourceCollectorResult<T> = Readonly<{
  observation: ResourceObservation<T> | null;
  generation: number;
  startedAt: number;
  completedAt: number;
  collectorId: string;
  failure?: ResourceCollectorFailure;
}>;

export interface ResourceCollector<T, Input = void> {
  latest(): ResourceObservation<T> | null;
  fence(): number;
  observe(fence: number, timeoutMs: number, input?: Input): Promise<ResourceCollectorResult<T>>;
}

export type ResourceCollectorOptions<T, Input = void> = {
  collectorId: string;
  collect(input?: Input): Promise<T>;
  validateObservation?(observation: ResourceObservation<T>): void;
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

const FAILURE_MESSAGE_MAX_BYTES = 512;
export const RESOURCE_FAILURE_STDERR_MAX_BYTES = 2_048;
const FAILURE_CAUSE_MAX_BYTES = 512;
const FAILURE_CAUSE_MAX_DEPTH = 4;

function redactDiagnosticText(value: string): string {
  return value
    .replace(/\b(Bearer)\s+[^\s]+/gi, "$1 <redacted>")
    .replace(/\b([A-Z0-9_.-]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|AUTHORIZATION|COOKIE)[A-Z0-9_.-]*)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s]+)/gi, "$1=<redacted>")
    .replace(/\b(?:sk|ghp|github_pat|xox[baprs])[-_A-Za-z0-9]{16,}\b/gi, "<redacted>")
    .replace(/\b[A-Za-z0-9+/_=-]{48,}\b/g, "<redacted>")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim();
}

function boundedDiagnosticText(value: string, maxBytes: number, tail = false): string {
  const redacted = redactDiagnosticText(value);
  const bytes = Buffer.from(redacted);
  if (bytes.length <= maxBytes) return redacted;
  if (tail) {
    let start = bytes.length - maxBytes;
    while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
    return bytes.subarray(start).toString("utf8");
  }
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function diagnosticCauses(error: unknown): string[] {
  const causes: string[] = [];
  let current = error;
  for (let depth = 0; depth < FAILURE_CAUSE_MAX_DEPTH && current !== undefined; depth += 1) {
    if (current instanceof Error) {
      const message = boundedDiagnosticText(current.message, FAILURE_CAUSE_MAX_BYTES);
      if (message) causes.push(message);
      current = current.cause;
      continue;
    }
    const message = boundedDiagnosticText(String(current), FAILURE_CAUSE_MAX_BYTES);
    if (message) causes.push(message);
    break;
  }
  return causes;
}

function resourceCollectorFailure(
  reason: ResourceDegradedReason,
  cause: ResourceFailureCause,
  message: string,
  options: { cause?: unknown; stderr?: string } = {},
): ResourceCollectorFailure {
  const stderr = options.stderr === undefined
    ? undefined
    : boundedDiagnosticText(options.stderr, RESOURCE_FAILURE_STDERR_MAX_BYTES, true);
  return freeze({
    reason,
    diagnostic: {
      cause,
      message: boundedDiagnosticText(message, FAILURE_MESSAGE_MAX_BYTES),
      causes: diagnosticCauses(options.cause),
      ...(stderr ? { stderr } : {}),
    },
  });
}

export class ResourceCollectorFailureError extends Error {
  readonly failure: ResourceCollectorFailure;

  constructor(
    reason: ResourceDegradedReason,
    cause: ResourceFailureCause,
    message: string,
    options: { cause?: unknown; stderr?: string } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ResourceCollectorFailureError";
    this.failure = resourceCollectorFailure(reason, cause, message, options);
  }
}

function failureFromError(error: unknown): ResourceCollectorFailure {
  if (error instanceof ResourceCollectorFailureError) return error.failure;
  return resourceCollectorFailure("collector-crash", "collector-error", "resource collection failed", { cause: error });
}

/**
 * Generation-fenced observation collector. Its interface keeps request paths
 * independent of collection mechanics: an adapter may gather in-process for
 * rollback or isolate the same work in a worker.
 */
export function createResourceCollector<T, Input = void>(options: ResourceCollectorOptions<T, Input>): ResourceCollector<T, Input> {
  const now = options.now ?? Date.now;
  let startedGeneration = options.initial?.generation ?? 0;
  let latest: ResourceObservation<T> | null = options.initial ?? null;
  let active: { generation: number; promise: Promise<ResourceObservation<T>> } | null = null;

  const launch = (input?: Input): Promise<ResourceObservation<T>> => {
    const generation = ++startedGeneration;
    const startedAt = now();
    const promise = Promise.resolve()
      .then(() => options.collect(input))
      .then((value) => {
        const observation = {
          generation,
          startedAt,
          completedAt: now(),
          collectorId: options.collectorId,
          value: freeze(value),
        };
        options.validateObservation?.(observation);
        return freeze(observation);
      });
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

  const afterFence = (fence: number, input?: Input): Promise<ResourceObservation<T>> => {
    const current = active;
    if (!current) return launch(input);
    if (current.generation > fence) return current.promise;
    return current.promise.catch(() => undefined).then(() => {
      const next = active;
      return next && next.generation > fence ? next.promise : launch(input);
    });
  };

  return {
    latest: () => latest,
    fence: () => startedGeneration,
    async observe(fence, timeoutMs, input) {
      const requestedAt = now();
      const observation = afterFence(fence, input);
      const result = (value: ResourceObservation<T> | null, failure?: ResourceCollectorFailure): ResourceCollectorResult<T> => freeze({
        observation: value,
        generation: failure ? Math.max(startedGeneration, value?.generation ?? 0) : (value?.generation ?? startedGeneration),
        startedAt: requestedAt,
        completedAt: now(),
        collectorId: options.collectorId,
        ...(failure ? { failure } : {}),
      });
      const bounded = Math.max(0, timeoutMs);
      if (bounded === 0) {
        void observation.catch(() => undefined);
        return result(latest, resourceCollectorFailure(
          "collector-busy",
          "collection-active",
          "resource collection is still active",
        ));
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = Symbol("resource-observation-timeout");
      try {
        const value = await Promise.race([
          observation,
          new Promise<typeof timeout>((resolve) => {
            timer = setTimeout(() => resolve(timeout), bounded);
          }),
        ]);
        if (value === timeout) {
          return result(latest, resourceCollectorFailure(
            "timeout",
            "observation-timeout",
            "resource collection observation timed out",
          ));
        }
        return result(value);
      } catch (error) {
        return result(latest, failureFromError(error));
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}
