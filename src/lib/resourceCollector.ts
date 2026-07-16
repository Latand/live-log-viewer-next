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
  quoteEscapeDepth: number;
  quotedKey: boolean;
  authorization: boolean;
  bearer: boolean;
};

function sensitiveTextMatch(value: string): SensitiveTextMatch | null {
  const keyed = /(^|[^A-Z0-9_.-])((?:\\+)?["']?)([A-Z0-9_.-]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|AUTHORIZATION|COOKIE)[A-Z0-9_.-]*)\2\s*[:=]\s*(?!<redacted>(?:$|[\s,}\]]))(?:((?:\\+)?["'])|(?=[^"'\\\s]))/i.exec(value);
  const bearer = /\b(Bearer)\s+(?:((?:\\+)?["'])|(?=\S))/i.exec(value);
  const standalone = /\b(?:(?:sk|ghp|github_pat|xox[baprs])[-_A-Za-z0-9]{16,}|[A-Za-z0-9+/_=-]{48,})/i.exec(value);
  const matches: SensitiveTextMatch[] = [];
  if (keyed) {
    const quoteToken = keyed[4] ?? "";
    const quote = quoteToken.at(-1);
    matches.push({
      index: keyed.index + keyed[1].length,
      length: keyed[0].length - keyed[1].length,
      replacement: `${keyed[3]}=<redacted>`,
      quote: quote === "\"" || quote === "'" ? quote : null,
      quoteEscapeDepth: Math.max(0, quoteToken.length - 1),
      quotedKey: keyed[2].endsWith("\"") || keyed[2].endsWith("'"),
      authorization: /AUTHORIZATION/i.test(keyed[3]),
      bearer: false,
    });
  }
  if (bearer) {
    const quoteToken = bearer[2] ?? "";
    const quote = quoteToken.at(-1);
    matches.push({
      index: bearer.index,
      length: bearer[0].length,
      replacement: `${bearer[1]} <redacted>`,
      quote: quote === "\"" || quote === "'" ? quote : null,
      quoteEscapeDepth: Math.max(0, quoteToken.length - 1),
      quotedKey: false,
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
      quoteEscapeDepth: 0,
      quotedKey: false,
      authorization: false,
      bearer: false,
    });
  }
  return matches.sort((left, right) => left.index - right.index)[0] ?? null;
}

function quotedValueEnd(value: string, quote: "\"" | "'", escapeDepth: number, start = 0): number {
  let backslashes = 0;
  for (let index = start; index < value.length; index += 1) {
    const character = value[index];
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    if (character === quote && backslashes === escapeDepth) return index + 1;
    backslashes = 0;
  }
  return -1;
}

function redactDiagnosticText(value: string): string {
  let redacted = "";
  let pending = value;
  while (pending) {
    const match = sensitiveTextMatch(pending);
    if (!match) {
      redacted += pending;
      break;
    }
    redacted += pending.slice(0, match.index) + match.replacement;
    pending = pending.slice(match.index + match.length);
    if (match.authorization && !(match.quotedKey && match.quote)) {
      const end = pending.search(/[\r\n]/);
      pending = end < 0 ? "" : pending.slice(end);
      continue;
    }
    if (match.quote) {
      const end = quotedValueEnd(pending, match.quote, match.quoteEscapeDepth);
      pending = end < 0 ? "" : pending.slice(end);
      continue;
    }
    if (match.bearer) {
      const end = pending.search(/[\r\n]/);
      pending = end < 0 ? "" : pending.slice(end);
      continue;
    }
    if (!match.authorization) {
      const end = pending.search(/\s/);
      pending = end < 0 ? "" : pending.slice(end);
    }
  }
  return redacted
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim();
}

function boundedUtf8Text(value: string, maxBytes: number, tail = false): string {
  const bytes = Buffer.from(value);
  if (bytes.length <= maxBytes) return value;
  if (tail) {
    const marker = "...";
    let start = bytes.length - Math.max(0, maxBytes - Buffer.byteLength(marker));
    while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
    return marker.slice(0, maxBytes) + bytes.subarray(start).toString("utf8");
  }
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function boundedDiagnosticText(value: string, maxBytes: number, tail = false): string {
  return boundedUtf8Text(redactDiagnosticText(value), maxBytes, tail);
}

export function createResourceDiagnosticTail(maxBytes = RESOURCE_FAILURE_STDERR_MAX_BYTES): {
  append(value: string): void;
  value(): string;
} {
  let sanitizedTail = "";
  let pending = "";
  let redacting: "unquoted" | "line" | "\"" | "'" | null = null;
  let redactionQuoteEscapeDepth = 0;
  let redactionTrailingBackslashes = 0;
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
    const beginCredentialRedaction = (lineWhenUnquoted = false) => {
      const quoteToken = /^((?:\\+)?["'])/.exec(pending)?.[1] ?? "";
      const quote = quoteToken.at(-1);
      if (quote === "\"" || quote === "'") {
        pending = pending.slice(quoteToken.length);
        redacting = quote;
        redactionQuoteEscapeDepth = quoteToken.length - 1;
        redactionTrailingBackslashes = 0;
      } else {
        redacting = lineWhenUnquoted ? "line" : "unquoted";
      }
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
        beginCredentialRedaction(true);
        continue;
      }
      if (carriedCredential === "value") {
        const valueStart = pending.search(/\S/);
        if (valueStart < 0) {
          pending = "";
          return;
        }
        pending = pending.slice(valueStart);
        beginCredentialRedaction();
        carriedCredential = null;
        continue;
      }
      if (carriedCredential === "key" || carriedCredential === "authorization-key") {
        const authorizationKey = carriedCredential === "authorization-key";
        const completedKey = /^[A-Z0-9_.-]*\s*[:=]\s*(?:((?:\\+)?["'])|(?=[^"'\\\s]))/i.exec(pending);
        if (completedKey) {
          appendSanitized("<redacted>");
          pending = pending.slice(completedKey[0].length);
          const quoteToken = completedKey[1] ?? "";
          const quote = quoteToken.at(-1);
          if (quote === "\"" || quote === "'") redacting = quote;
          else redacting = authorizationKey ? "line" : "unquoted";
          redactionQuoteEscapeDepth = quoteToken.length > 0 ? quoteToken.length - 1 : 0;
          redactionTrailingBackslashes = 0;
          carriedCredential = null;
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
        let end: number;
        if (redacting === "line") end = pending.search(/[\r\n]/);
        else if (redacting === "unquoted") end = pending.search(/\s/);
        else {
          end = -1;
          let backslashes = redactionTrailingBackslashes;
          for (let index = 0; index < pending.length; index += 1) {
            const character = pending[index];
            if (character === "\\") {
              backslashes += 1;
              continue;
            }
            if (character === redacting && backslashes === redactionQuoteEscapeDepth) {
              end = index;
              break;
            }
            backslashes = 0;
          }
          redactionTrailingBackslashes = backslashes;
        }
        if (end < 0) {
          pending = "";
          return;
        }
        pending = pending.slice(end + (redacting === "unquoted" || redacting === "line" ? 0 : 1));
        redacting = null;
        redactionQuoteEscapeDepth = 0;
        redactionTrailingBackslashes = 0;
        continue;
      }
      const match = sensitiveTextMatch(pending);
      if (match) {
        appendSanitized(pending.slice(0, match.index) + match.replacement);
        pending = pending.slice(match.index + match.length);
        if (match.authorization) {
          redacting = match.quotedKey && match.quote ? match.quote : "line";
          redactionQuoteEscapeDepth = match.quoteEscapeDepth;
          continue;
        }
        if (match.bearer) {
          redacting = match.quote ?? "line";
          redactionQuoteEscapeDepth = match.quoteEscapeDepth;
          continue;
        }
        redacting = match.quote ?? "unquoted";
        redactionQuoteEscapeDepth = match.quoteEscapeDepth;
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
      const carriedKey = /(^|[^A-Z0-9_.-])((?:\\+)?["']?)([A-Z0-9_.-]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|AUTHORIZATION|COOKIE)[A-Z0-9_.-]*)\2(\s*)(?:([:=])(\s*))?$/i.exec(pending);
      if (carriedKey) {
        const keyStart = carriedKey.index + carriedKey[1].length;
        if (keyStart < pending.length - DIAGNOSTIC_REDACTION_CONTEXT_CHARS) {
          appendSanitized(pending.slice(0, keyStart));
          if (carriedKey[5]) {
            appendSanitized("<redacted>");
            pending = "";
            carriedCredential = /AUTHORIZATION/i.test(carriedKey[3]) ? "authorization" : "value";
          } else {
            pending = (carriedKey[3] + carriedKey[4]).slice(-DIAGNOSTIC_REDACTION_CONTEXT_CHARS);
            carriedCredential = /AUTHORIZATION/i.test(carriedKey[3]) ? "authorization-key" : "key";
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
      return boundedDiagnosticText(sanitizedTail + suffix, maxBytes, true);
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
