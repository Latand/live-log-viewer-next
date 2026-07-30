import crypto from "node:crypto";

import { writeJsonDurably } from "@/lib/state/durableJson";
import { withFileTransactionSync } from "@/lib/state/fileTransaction";

import { bridgeReportLogPath, readBridgeReportLog } from "./store";
import type { BridgeConfirmation } from "./types";

/**
 * The deploy round trip's authorization half (§4, §7.7).
 *
 * The user's "yes" is spoken to the gateway, and the gateway does not deploy —
 * it relays. So an authorization has to survive a hop through a conversation and
 * still bind to exactly one commit: hence a nonce the manager minted, a full SHA
 * that must match character for character, an expiry, and a single-use mark.
 *
 * All four checks happen at *execution* time, in the manager, immediately before
 * `deploy_exact_sha`. Checking earlier would authorize a deploy that then waits
 * — and a deploy authorized ten minutes ago for a SHA that has since been
 * superseded is exactly what the confirmation exists to prevent.
 */

/** U8 proposes 10 minutes; the operator has not ruled, so this is the seam that
    changes when they do (one constant, one place). */
export const BRIDGE_CONFIRMATION_TTL_MS = 10 * 60 * 1_000;

const FULL_SHA = /^[0-9a-f]{40}$/;

export type BridgeConfirmationRefusal =
  | "no_confirmation"
  | "nonce_mismatch"
  | "sha_mismatch"
  | "expired"
  | "consumed"
  | "superseded";

export type BridgeConfirmationVerdict =
  | { ok: true }
  | { ok: false; reason: BridgeConfirmationRefusal };

export interface BridgeConfirmationAnswer {
  sha: string;
  nonce: string;
}

/**
 * Mint the authorization the manager attaches to a `confirmation_request`.
 *
 * Lowercase full SHA only: `deploy_exact_sha` already refuses anything shorter,
 * and accepting an abbreviation here would mean the string the user agreed to
 * and the string that ships were resolved by different rules.
 */
export function mintBridgeConfirmation(
  options: { sha: string; now?: Date; ttlMs?: number },
): BridgeConfirmation {
  if (!FULL_SHA.test(options.sha)) {
    throw new Error("a bridge confirmation requires a full lowercase 40-hex commit SHA");
  }
  const now = options.now ?? new Date();
  const ttlMs = options.ttlMs ?? BRIDGE_CONFIRMATION_TTL_MS;
  return {
    sha: options.sha,
    nonce: crypto.randomBytes(16).toString("hex"),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
  };
}

/**
 * Whether this answer authorizes this request, right now. Pure, so the manager's
 * gate and any test agree by construction.
 *
 * Nonce first: a wrong nonce means this answer belongs to some other request,
 * and reporting the SHA relationship of an answer that was never addressed here
 * would be answering a question nobody asked.
 */
export function verifyBridgeConfirmation(
  confirmation: BridgeConfirmation | undefined,
  answer: BridgeConfirmationAnswer,
  now: Date,
): BridgeConfirmationVerdict {
  if (!confirmation) return { ok: false, reason: "no_confirmation" };
  if (confirmation.consumedAt) return { ok: false, reason: "consumed" };
  /* #795: a newer accepted deploy intent repinned this project. The old
     authorization must refuse even inside its expiry window — the operator's
     latest word is the only live one. */
  if (confirmation.supersededAt) return { ok: false, reason: "superseded" };
  if (!timingSafeEqualStrings(confirmation.nonce, answer.nonce)) return { ok: false, reason: "nonce_mismatch" };
  if (confirmation.sha !== answer.sha) return { ok: false, reason: "sha_mismatch" };
  const expiresAt = Date.parse(confirmation.expiresAt);
  if (!Number.isFinite(expiresAt) || now.getTime() > expiresAt) return { ok: false, reason: "expired" };
  return { ok: true };
}

/** Constant-time over equal-length inputs; a length difference is already
    public, so comparing lengths first leaks nothing a caller cannot see. */
function timingSafeEqualStrings(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  if (leftBytes.byteLength !== rightBytes.byteLength) return false;
  return crypto.timingSafeEqual(leftBytes, rightBytes);
}

export type BridgeConfirmationOutcome =
  | { ok: true; sha: string }
  | { ok: false; reason: BridgeConfirmationRefusal };

/**
 * Verify and consume in one file transaction — the whole point of this function.
 *
 * A verify that returns "yes" and a separate write that records the use are two
 * operations, and two concurrent answers can both pass the first before either
 * reaches the second. That race deploys the same SHA twice. Doing both under the
 * report log's lock makes "one confirmation authorizes one SHA once" a property
 * of the file rather than of the caller's discipline.
 */
export function consumeBridgeConfirmation(
  seq: number,
  answer: BridgeConfirmationAnswer,
  now = new Date(),
): BridgeConfirmationOutcome {
  return withFileTransactionSync(bridgeReportLogPath(), "bridge report log is busy", () => {
    const log = readBridgeReportLog();
    const index = log.reports.findIndex((report) => report.seq === seq);
    const report = index >= 0 ? log.reports[index]! : null;
    if (!report || report.class !== "confirmation_request") return { ok: false, reason: "no_confirmation" };

    const verdict = verifyBridgeConfirmation(report.confirmation, answer, now);
    if (!verdict.ok) return verdict;

    log.reports[index] = {
      ...report,
      confirmation: { ...report.confirmation!, consumedAt: now.toISOString() },
    };
    writeJsonDurably(bridgeReportLogPath(), log);
    return { ok: true, sha: report.confirmation!.sha };
  });
}
