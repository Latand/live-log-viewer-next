import crypto from "node:crypto";

import { taskTextFromPrompt } from "@/lib/tasks/inboxScanner";

import { redactBounded } from "./redact";
import type { OperatorRequest } from "./types";

/**
 * Lifting operator requests out of transcripts (issue #741).
 *
 * Three things have to be told apart here, and getting any of them wrong makes
 * the monitor either blind or a spam generator:
 *
 * 1. Operator text vs. everything else. Only `kind: "message"` with
 *    `role: "user"` is a person talking; assistant prose, reasoning and tool
 *    results all carry imperative-looking language and would otherwise read as
 *    requests.
 * 2. Operator text vs. the harness. Injected context, caveats and interrupt
 *    notices arrive on the same `user` records; {@link taskTextFromPrompt}
 *    already knows those shapes and is reused rather than re-derived.
 * 3. Operator text vs. the monitor itself. Every message the monitor delivers
 *    carries {@link MONITOR_MARKER}, and a delivered message lands in the
 *    target transcript as a `user` record — so without this the monitor would
 *    read its own report back and materialize cards for the gaps it just
 *    reported.
 */

/** Stamped on every message the monitor delivers; its own echo cancellation. */
export const MONITOR_MARKER = "⟦conversation-monitor⟧";

/** Upper bound on the request body carried into a card or a report. */
const REQUEST_TEXT_LIMIT = 800;
const TITLE_LIMIT = 96;

export interface MonitorSessionRecord {
  kind: string;
  role: string;
  ts: string | null;
  text: string;
}

export interface RequestWindow {
  fromMs: number;
  toMs: number;
}

/** Whether this text was written by the monitor rather than by a person. */
export function isMonitorAuthored(text: string): boolean {
  return text.includes(MONITOR_MARKER);
}

/**
 * Content address of a request, stable across capitalization, punctuation and
 * whitespace so the same ask re-typed a second time lands on the same card.
 * Bounded to the head of the text: a long request with a changing tail (a
 * pasted log, a shifting sha) must still fingerprint as itself.
 */
export function requestFingerprint(text: string): string {
  const normalized = text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .slice(0, 400);
  return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

function referencesIn(text: string): number[] {
  const found = new Set<number>();
  for (const match of text.matchAll(/(?<![\w#])#(\d{1,6})\b/g)) {
    const value = Number(match[1]);
    if (Number.isSafeInteger(value) && value > 0) found.add(value);
  }
  return [...found].sort((left, right) => left - right);
}

/** Whether the operator is asking for a GitHub issue specifically. The monitor
    never actuates one; it surfaces the candidate as unconfirmed instead. */
function asksForGithubIssue(text: string): boolean {
  return /(?:github\s+issue|issue\s+on\s+github|заведи\s+(?:тикет|issue)|созда(?:й|ть)\s+issue|open\s+an?\s+issue|create\s+an?\s+issue)/i.test(text);
}

/**
 * The concrete operator requests in one conversation's records, bounded to the
 * window and deduplicated by fingerprint (the earliest instant wins — that is
 * when the operator actually asked).
 */
export function operatorRequestsFrom(
  records: readonly MonitorSessionRecord[],
  project: string,
  window: RequestWindow,
): OperatorRequest[] {
  const byFingerprint = new Map<string, OperatorRequest>();
  for (const record of records) {
    if (record.kind !== "message" || record.role !== "user") continue;
    if (!record.ts) continue;
    const at = Date.parse(record.ts);
    if (!Number.isFinite(at) || at < window.fromMs || at > window.toMs) continue;
    const text = typeof record.text === "string" ? record.text : "";
    if (!text.trim() || isMonitorAuthored(text)) continue;
    /* Doubles as the concrete-request test: a title comes back only for a
       prompt that is neither harness noise nor conversational chatter. */
    const title = taskTextFromPrompt(text);
    if (!title) continue;
    const fingerprint = requestFingerprint(text);
    const existing = byFingerprint.get(fingerprint);
    if (existing) {
      if (Date.parse(existing.at) > at) existing.at = new Date(at).toISOString();
      continue;
    }
    byFingerprint.set(fingerprint, {
      fingerprint,
      title: redactBounded(title, TITLE_LIMIT),
      text: redactBounded(text, REQUEST_TEXT_LIMIT),
      project,
      at: new Date(at).toISOString(),
      references: referencesIn(text),
      asksForGithubIssue: asksForGithubIssue(text),
    });
  }
  return [...byFingerprint.values()].sort((left, right) => left.at.localeCompare(right.at));
}
