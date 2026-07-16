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
  | "worker-failure"
  | "worker-cleanup";

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
const DIAGNOSTIC_REDACTION_CONTEXT_CHARS = 256;

type ResourceFailureOptions = {
  cause?: unknown;
  stderr?: string;
  secondaryCauses?: readonly unknown[];
};

type SensitiveTextMatch = {
  index: number;
  length: number;
  replacement: string;
  quote: "\"" | "'" | null;
  authorization: boolean;
  bearer: boolean;
};

function sensitiveTextMatch(value: string): SensitiveTextMatch | null {
  const keyed = /\b([A-Z0-9_.-]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|AUTHORIZATION|COOKIE)[A-Z0-9_.-]*)\s*[:=]\s*(?:(["'])|(?=[^"'\s]))/i.exec(value);
  const bearer = /\b(Bearer)\s+(?=\S)/i.exec(value);
  const standalone = /\b(?:(?:sk|ghp|github_pat|xox[baprs])[-_A-Za-z0-9]{16,}|[A-Za-z0-9+/_=-]{48,})/i.exec(value);
  const matches: SensitiveTextMatch[] = [];
  if (keyed) {
    matches.push({
      index: keyed.index,
      length: keyed[0].length,
      replacement: `${keyed[1]}=<redacted>`,
      quote: keyed[2] === "\"" || keyed[2] === "'" ? keyed[2] : null,
      authorization: /AUTHORIZATION/i.test(keyed[1]),
      bearer: false,
    });
  }
  if (bearer) {
    matches.push({
      index: bearer.index,
      length: bearer[0].length,
      replacement: `${bearer[1]} <redacted>`,
      quote: null,
      authorization: false,
      bearer: true,
    });
  }
  if (standalone) {
    matches.push({
      index: standalone.index,
      length: standalone[0].length,
      replacement: "<redacted>",
      quote: null,
      authorization: false,
      bearer: false,
    });
  }
  return matches.sort((left, right) => left.index - right.index)[0] ?? null;
}

function redactDiagnosticText(value: string): string {
  return value
    .replace(/\b([A-Z0-9_.-]*AUTHORIZATION[A-Z0-9_.-]*)\s*[:=][^\r\n]*/gi, "$1=<redacted>")
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

export function createResourceDiagnosticTail(maxBytes = RESOURCE_FAILURE_STDERR_MAX_BYTES): {
  append(value: string): void;
  value(): string;
} {
  let sanitizedTail = "";
  let pending = "";
  let redacting: "unquoted" | "line" | "\"" | "'" | null = null;
  let carriedCredential: "key" | "authorization-key" | "value" | "authorization" | "bearer" | null = null;
  const appendSanitized = (value: string) => {
    sanitizedTail += value;
    let start = sanitizedTail.length - (maxBytes * 2);
    if (start <= 0) return;
    const first = sanitizedTail.charCodeAt(start);
    if (first >= 0xdc00 && first <= 0xdfff) start += 1;
    sanitizedTail = sanitizedTail.slice(start);
  };
  const sanitizePending = () => {
    const beginCredentialRedaction = () => {
      const quote = pending[0];
      if (quote === "\"" || quote === "'") pending = pending.slice(1);
      redacting = quote === "\"" || quote === "'" ? quote : "unquoted";
      carriedCredential = null;
    };
    while (pending) {
      if (carriedCredential === "authorization") {
        redacting = "line";
        carriedCredential = null;
        continue;
      }
      if (carriedCredential === "bearer") {
        const valueStart = pending.search(/\S/);
        if (valueStart < 0) {
          pending = "";
          return;
        }
        pending = pending.slice(valueStart);
        beginCredentialRedaction();
        continue;
      }
      if (carriedCredential === "value") {
        const valueStart = pending.search(/\S/);
        if (valueStart < 0) {
          pending = "";
          return;
        }
        const quote = pending[valueStart];
        pending = pending.slice(valueStart + (quote === "\"" || quote === "'" ? 1 : 0));
        redacting = quote === "\"" || quote === "'" ? quote : "unquoted";
        carriedCredential = null;
        continue;
      }
      if (carriedCredential === "key" || carriedCredential === "authorization-key") {
        const authorizationKey = carriedCredential === "authorization-key";
        const completedKey = /^[A-Z0-9_.-]*\s*[:=]\s*(?:(["'])|(?=[^"'\s]))/i.exec(pending);
        if (completedKey) {
          appendSanitized("<redacted>");
          pending = pending.slice(completedKey[0].length);
          if (authorizationKey) {
            redacting = "line";
            carriedCredential = null;
          }
          else {
            redacting = completedKey[1] === "\"" || completedKey[1] === "'" ? completedKey[1] : "unquoted";
            carriedCredential = null;
          }
          continue;
        }
        const delimiter = /^[A-Z0-9_.-]*\s*[:=]\s*$/i.exec(pending);
        if (delimiter) {
          appendSanitized("<redacted>");
          pending = "";
          carriedCredential = authorizationKey ? "authorization" : "value";
          return;
        }
        if (/^[A-Z0-9_.-]*\s*$/i.test(pending)) {
          pending = pending.slice(-DIAGNOSTIC_REDACTION_CONTEXT_CHARS);
          return;
        }
        carriedCredential = null;
      }
      if (redacting) {
        const end = redacting === "line"
          ? pending.search(/[\r\n]/)
          : redacting === "unquoted" ? pending.search(/\s/) : pending.indexOf(redacting);
        if (end < 0) {
          pending = "";
          return;
        }
        pending = pending.slice(end + (redacting === "unquoted" || redacting === "line" ? 0 : 1));
        redacting = null;
        continue;
      }
      const match = sensitiveTextMatch(pending);
      if (match) {
        appendSanitized(pending.slice(0, match.index) + match.replacement);
        pending = pending.slice(match.index + match.length);
        if (match.authorization) {
          redacting = "line";
          continue;
        }
        if (match.bearer) {
          carriedCredential = "bearer";
          continue;
        }
        redacting = match.quote ?? "unquoted";
        continue;
      }
      if (pending.length <= DIAGNOSTIC_REDACTION_CONTEXT_CHARS) return;
      const carriedBearer = /(?:^|[^A-Z0-9_])(Bearer)(\s+)$/i.exec(pending);
      if (carriedBearer) {
        const bearerStart = carriedBearer.index + carriedBearer[0].length
          - carriedBearer[1].length - carriedBearer[2].length;
        if (bearerStart < pending.length - DIAGNOSTIC_REDACTION_CONTEXT_CHARS) {
          appendSanitized(pending.slice(0, bearerStart) + `${carriedBearer[1]} <redacted>`);
          pending = "";
          carriedCredential = "bearer";
          return;
        }
      }
      const carriedKey = /(?:^|[^A-Z0-9_.-])([A-Z0-9_.-]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|AUTHORIZATION|COOKIE)[A-Z0-9_.-]*)(\s*)(?:([:=])(\s*))?$/i.exec(pending);
      if (carriedKey) {
        const keyStart = carriedKey.index + carriedKey[0].length
          - carriedKey.slice(1).reduce((length, part) => length + (part?.length ?? 0), 0);
        if (keyStart < pending.length - DIAGNOSTIC_REDACTION_CONTEXT_CHARS) {
          appendSanitized(pending.slice(0, keyStart));
          if (carriedKey[3]) {
            appendSanitized("<redacted>");
            pending = "";
            carriedCredential = /AUTHORIZATION/i.test(carriedKey[1]) ? "authorization" : "value";
          } else {
            pending = (carriedKey[1] + carriedKey[2]).slice(-DIAGNOSTIC_REDACTION_CONTEXT_CHARS);
            carriedCredential = /AUTHORIZATION/i.test(carriedKey[1]) ? "authorization-key" : "key";
          }
          return;
        }
      }
      appendSanitized(pending.slice(0, -DIAGNOSTIC_REDACTION_CONTEXT_CHARS));
      pending = pending.slice(-DIAGNOSTIC_REDACTION_CONTEXT_CHARS);
      return;
    }
  };

  return {
    append(value) {
      pending += value;
      sanitizePending();
    },
    value() {
      const suffix = redacting ? "" : pending;
      return redactDiagnosticText(sanitizedTail + suffix);
    },
  };
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

function combinedDiagnosticCauses(primary: unknown, secondary: readonly unknown[] = []): string[] {
  const causes: string[] = [];
  for (const error of [primary, ...secondary]) {
    for (const cause of diagnosticCauses(error)) {
      causes.push(cause);
      if (causes.length === FAILURE_CAUSE_MAX_DEPTH) return causes;
    }
  }
  return causes;
}

function resourceCollectorFailure(
  reason: ResourceDegradedReason,
  cause: ResourceFailureCause,
  message: string,
  options: ResourceFailureOptions = {},
): ResourceCollectorFailure {
  const stderr = options.stderr === undefined
    ? undefined
    : boundedDiagnosticText(options.stderr, RESOURCE_FAILURE_STDERR_MAX_BYTES, true);
  return freeze({
    reason,
    diagnostic: {
      cause,
      message: boundedDiagnosticText(message, FAILURE_MESSAGE_MAX_BYTES),
      causes: combinedDiagnosticCauses(options.cause, options.secondaryCauses),
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
    options: ResourceFailureOptions = {},
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
