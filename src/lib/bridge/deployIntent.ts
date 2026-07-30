import { execFile } from "node:child_process";

import { BRIDGE_CONFIRMATION_TTL_MS, mintBridgeConfirmation } from "./confirmation";
import { recordDirectDeployIntent } from "./store";
import type { BridgeReportOrigin } from "./types";

/**
 * #795 — intent acceptance: the moment the operator's spoken deploy becomes an
 * exact, single-use authorization.
 *
 * The operator says a deploy in their own words; nothing about a revision ever
 * reaches them. What pins the deployment is this module: remote main is
 * resolved to one 40-hex commit HERE, at acceptance, and recorded together
 * with the project, the designated seat, the relaying origin, an expiry and
 * the directive-derived idempotency key. Execution later verifies and spends
 * exactly that record — pinning at execution instead would deploy whatever
 * main had drifted to, which is not what the operator said yes to.
 *
 * Fail-closed by construction: a remote that cannot be resolved mints nothing,
 * so there is never an authorization whose revision is a guess.
 */

/** Same bounded lifetime as the legacy confirmation round trip: one seam. */
export const DEPLOY_INTENT_TTL_MS = BRIDGE_CONFIRMATION_TTL_MS;

const FULL_SHA = /^[0-9a-f]{40}$/;

/** The idempotency identity of an intent IS its directive's delivery id. A
    relay retry re-presents the same id and gets the same authorization back. */
export function deployIntentKey(directiveId: string): string {
  return `deploy_intent_${directiveId}`;
}

const DEFAULT_CANONICAL_REMOTE = "https://github.com/Latand/live-log-viewer-next.git";

/**
 * Production pin: ask the canonical remote — the same remote the deployment
 * adapter builds from — what main is, without needing any local checkout or
 * the runtime host to be reachable. `git ls-remote` is a pure read.
 */
export async function resolveRemoteMainRevision(): Promise<string> {
  const remote = process.env.LLV_VIEWER_CANONICAL_REMOTE?.trim() || DEFAULT_CANONICAL_REMOTE;
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      "git",
      ["ls-remote", remote, "refs/heads/main"],
      { timeout: 20_000 },
      (error, out) => (error ? reject(error) : resolve(out)),
    );
  });
  const revision = stdout.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (!FULL_SHA.test(revision)) {
    throw new Error("the canonical remote did not resolve main to a full commit SHA");
  }
  return revision;
}

export interface AcceptedDeployIntent {
  /** The authorization row's seq — what execution presents as `bridgeRef`. */
  ref: number;
  /** The single-use bearer secret — what execution presents as `bridgeNonce`. */
  nonce: string;
  /** The exact revision pinned at acceptance. Internal evidence; never routed
      back through the operator. */
  sha: string;
  expiresAt: string;
  /** True when this directive id was already accepted: the SAME authorization
      is returned and nothing is re-pinned or superseded. */
  replayed: boolean;
  supersededSeqs: number[];
}

export interface AcceptDeployIntentOptions {
  /** The directive's delivery id (`bridge_d_<turn>_<utterance>`). */
  directiveId: string;
  project: string;
  seatConversationId: string;
  /** Server-attributed relaying origin; the caller never supplies it. */
  origin: BridgeReportOrigin;
  /** The operator's words, kept as the audit body. */
  instruction: string;
  resolveRemoteMain?: () => Promise<string>;
  now?: Date;
  ttlMs?: number;
}

/**
 * Accept one direct deploy intent: pin, mint, record — one consumable
 * authorization in the existing bridge-log format, which is exactly what makes
 * the already-deployed executor able to consume it (see the #795 design note's
 * bootstrap section).
 */
export async function acceptDirectDeployIntent(
  options: AcceptDeployIntentOptions,
): Promise<AcceptedDeployIntent> {
  const now = options.now ?? new Date();
  const resolve = options.resolveRemoteMain ?? resolveRemoteMainRevision;
  const sha = (await resolve()).toLowerCase();
  if (!FULL_SHA.test(sha)) {
    throw new Error("the pinned revision must be a full 40-hex commit SHA");
  }
  const confirmation = mintBridgeConfirmation({
    sha,
    now,
    ttlMs: options.ttlMs ?? DEPLOY_INTENT_TTL_MS,
  });
  const recorded = recordDirectDeployIntent({
    key: deployIntentKey(options.directiveId),
    project: options.project,
    seatConversationId: options.seatConversationId,
    origin: options.origin,
    body: `Operator deploy intent: ${options.instruction}`,
    confirmation,
    at: now.toISOString(),
  }, now);
  const stored = recorded.report.confirmation!;
  return {
    ref: recorded.report.seq,
    nonce: stored.nonce,
    sha: stored.sha,
    expiresAt: stored.expiresAt,
    replayed: recorded.replayed,
    supersededSeqs: recorded.supersededSeqs,
  };
}
