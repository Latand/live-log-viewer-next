/**
 * A read that failed is not a fact (#1131).
 *
 * Every finding this lane closed was one shape: a read that could not be
 * completed was converted at the call site into a definite value — `null`,
 * `false`, an absent owner — and that value was then acted on as proof.
 * Missing ownership became proof of abandonment. An unreadable status became
 * proof that nothing was delivered. An unreadable settlement record became
 * proof that nothing was settled. Each conversion was written once per site, so
 * closing one left the others standing.
 *
 * This is the conversion, written once. A read has THREE answers:
 *
 * - it **matches** the evidence acted on — proceed;
 * - it **differs** — that is proof, act on it;
 * - it **could not be read** — this authorises nothing. It does not terminalize
 *   a row, does not classify anything as abandoned, does not let a second
 *   engine actuation through, and does not let a response hand out an id
 *   nothing will settle. The caller blocks or retries, and the receipt deadline
 *   is what bounds the wait.
 *
 * A source that was never wired is NOT a failed read: an optional port method
 * that does not exist says the deployment carries no such fence, which is a
 * fact about the configuration and is answered with {@link readEvidence}'s
 * `whenAbsent` value. Only a read that was attempted and threw is unreadable.
 */
export type Evidence<T> =
  | { readonly readable: true; readonly value: T }
  | { readonly readable: false; readonly reason: string };

/** What comparing evidence against an expectation proves. */
export type EvidenceComparison = "matches" | "differs" | "unknown";

const UNREADABLE_REASON_LIMIT = 240;

/** Why a read could not be completed, in the shape a durable reason carries. */
export function unreadableReason(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return (message.trim() || fallback).slice(0, UNREADABLE_REASON_LIMIT);
}

/**
 * Evidence for a read that could not be performed at all.
 *
 * For callers whose source is missing in a way that IS an outage rather than a
 * configuration — a runtime socket that is not there is the runtime host being
 * unreachable, not a deployment that carries no journal.
 */
export function unreadableEvidence(reason: string): Evidence<never> {
  return { readable: false, reason };
}

/** Performs one failable read and keeps whether it succeeded. */
export async function readEvidence<T>(
  read: () => T | PromiseLike<T>,
  fallbackReason = "evidence could not be read",
): Promise<Evidence<T>> {
  try {
    return { readable: true, value: await read() };
  } catch (error) {
    return { readable: false, reason: unreadableReason(error, fallbackReason) };
  }
}

/**
 * The same read where the SOURCE itself is optional.
 *
 * An optional port method can be passed straight in: an absent source answers
 * `whenAbsent` as a completed read, because a capability that was never wired
 * is a fact about the deployment rather than a failure. Only an attempted read
 * that threw is unreadable.
 */
export async function readOptionalEvidence<T>(
  read: (() => T | PromiseLike<T>) | undefined,
  whenAbsent: T,
  fallbackReason = "evidence could not be read",
): Promise<Evidence<T>> {
  if (!read) return { readable: true, value: whenAbsent };
  return readEvidence(read, fallbackReason);
}

/**
 * What evidence proves about an expectation, in three answers.
 *
 * `null` on either side is `unknown` rather than `differs`: a read that
 * completed and found nothing recorded has found nothing to differ FROM, so it
 * proves exactly as much as a read that failed — nothing. Only two values that
 * are both present can disagree.
 */
export function evidenceAgrees<T>(
  evidence: Evidence<T | null | undefined>,
  expected: T | null | undefined,
): EvidenceComparison {
  if (!evidence.readable) return "unknown";
  if (evidence.value === null || evidence.value === undefined) return "unknown";
  if (expected === null || expected === undefined) return "unknown";
  return evidence.value === expected ? "matches" : "differs";
}
