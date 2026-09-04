/**
 * The composer's failed-delivery notice (issue #1362).
 *
 * The operator photographed three identical full-width red pills under the
 * composer, one per retry, each carrying the whole error sentence with its
 * tail clipped. This module is the pure half of the replacement: which settled
 * failures fold into ONE compact notice, what that notice says at rest, and
 * what expanding it reveals. The rendering lives in `RuntimeComposerReceipts`.
 *
 * No React, no I/O: the run and the wording are deterministic functions of
 * the visible receipts, so the collapse rule can be pinned on its own.
 */

import type { MessageKey, TFunction } from "@/lib/i18n";

import type { DeliveryAttemptGroup } from "./deliveryState";
import { deliveryProblem } from "./deliveryState";
import { humanReceiptReasonKey, receiptIsTerminal, type RuntimeReceipt } from "./runtimeModel";

/**
 * Terse causes for the verbatim sentence families the runtime produces. The
 * sentence itself (and the remediation after its semicolon) stays reachable
 * behind expand/hover; the row only ever shows the short form. Keyed on a
 * pattern rather than an exact string because the subject varies ("structured
 * spawn runtime host", "runtime host", "structured recovery runtime host").
 */
const CAUSE_PATTERNS: ReadonlyArray<readonly [RegExp, MessageKey]> = [
  [/\bruntime host is unavailable\b/i, "receipt.cause.hostUnavailable"],
  [/\btimed out\b/i, "receipt.cause.timedOut"],
];

function splitClauses(reason: string): { head: string; rest: string | null } {
  const index = reason.indexOf(";");
  if (index < 0) return { head: reason.trim(), rest: null };
  const rest = reason.slice(index + 1).trim();
  return { head: reason.slice(0, index).trim(), rest: rest || null };
}

function patternKey(head: string): MessageKey | null {
  for (const [pattern, key] of CAUSE_PATTERNS) {
    if (pattern.test(head)) return key;
  }
  return null;
}

/**
 * Identity of a failure cause, so identical consecutive failures collapse
 * regardless of casing, spacing, or which alias named a known reason code. A
 * verbatim sentence is identified by its first clause; the remediation after
 * the semicolon never splits a run.
 */
export function failureCauseKey(reason: string | null | undefined): string {
  const trimmed = reason?.trim() ?? "";
  if (!trimmed) return "";
  const known = humanReceiptReasonKey(trimmed);
  if (known) return `key:${known}`;
  const { head } = splitClauses(trimmed);
  return `verbatim:${patternKey(head) ?? head.replace(/\s+/g, " ").toLowerCase()}`;
}

export interface ReceiptFailureDescription {
  /** The terse cause for the at-rest row, or null when the receipt has none. */
  cause: string | null;
  /** The whole reason, for hover. */
  full: string | null;
  /** Every verbatim reason stays readable on expand, even if the row clips it.
      Known reason codes use their short human label and need no detail. */
  detail: { sentence: string; remediation: string | null } | null;
}

/**
 * The three forms one failure reason takes: a terse cause for the row, the
 * whole sentence for hover, and the sentence plus remediation for expand. A
 * known reason code is already a short human sentence and reveals nothing
 * further; a verbatim sentence splits at its first semicolon into what
 * happened and what to do about it.
 */
export function describeReceiptFailure(t: TFunction, reason: string | null | undefined): ReceiptFailureDescription {
  const trimmed = reason?.trim() ?? "";
  if (!trimmed) return { cause: null, full: null, detail: null };
  const known = humanReceiptReasonKey(trimmed);
  if (known) {
    const sentence = t(known);
    return { cause: sentence, full: sentence, detail: null };
  }
  const { head, rest } = splitClauses(trimmed);
  const key = patternKey(head);
  const cause = key ? t(key) : head;
  return {
    cause,
    full: trimmed,
    detail: { sentence: head, remediation: rest },
  };
}

export interface DeliveryNoticeRun {
  /** Newest failed attempt of the run — owns the notice's cause and retry. */
  current: RuntimeReceipt;
  causeKey: string;
  /** Every settled failed attempt the notice counts, newest first. */
  attempts: RuntimeReceipt[];
  /** Every settled attempt dismissing the notice hides (issue #264 rule 3). */
  dismissIds: string[];
}

/**
 * The failures the one notice stands for: the newest visible settled failure
 * plus every consecutive earlier one with the same cause. Candidates are the
 * message groups whose newest attempt is a settled problem, and the textless
 * message receipts (no echo to group by) that failed — each counted as its own
 * single-attempt group. A group still moving is not a failure, whatever its
 * history says, and an older failure with a different cause waits its turn in
 * the history until the run in front of it is dismissed.
 */
export function deliveryNoticeRun(
  groups: readonly DeliveryAttemptGroup[],
  textless: readonly RuntimeReceipt[],
): DeliveryNoticeRun | null {
  const candidates: DeliveryAttemptGroup[] = [
    ...groups.filter((group) => deliveryProblem(group.current.status)),
    ...textless
      .filter((receipt) => deliveryProblem(receipt.status))
      .map((receipt) => ({ current: receipt, attempts: [receipt] })),
  ].sort((left, right) => Date.parse(right.current.at) - Date.parse(left.current.at));
  const first = candidates[0];
  if (!first) return null;
  const causeKey = failureCauseKey(first.current.reason);
  const run: DeliveryAttemptGroup[] = [];
  for (const candidate of candidates) {
    if (failureCauseKey(candidate.current.reason) !== causeKey) break;
    run.push(candidate);
  }
  return {
    current: first.current,
    causeKey,
    attempts: run.flatMap((group) => group.attempts.filter((attempt) => deliveryProblem(attempt.status))),
    dismissIds: run.flatMap((group) => group.attempts
      .filter((attempt) => receiptIsTerminal(attempt.status))
      .map((attempt) => attempt.operationId)),
  };
}
