import crypto from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { accountProjection } from "@/lib/accounts/accountProjection";
import { listCodexAccounts, type CodexAccount } from "@/lib/accounts/codex";
import { redactAppServerDetail } from "@/lib/accounts/codexAppServerProtocol";
import { managedCodexRuntime, type CodexResetCreditRedemption } from "@/lib/accounts/codexRuntime";
import { recordLiveObservation, refreshAccountLimits } from "@/lib/accounts/liveLimits";
import { codexObservationFromProbe } from "@/lib/accounts/migration/quotaController";
import { appendResetCreditJournal, governingWindowSummary, readResetCreditJournal, type ResetCreditActor, type ResetCreditJournalEntry } from "@/lib/accounts/resetCreditJournal";
import { callerConversationId } from "@/lib/agent/operatorAuthority";
import { agentRegistry } from "@/lib/agent/registry";
import { logEvent } from "@/lib/events";
import { rejectCrossOrigin } from "@/lib/sameOrigin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Usage-limit reset credits (issue #1373) — a Viewer API route on purpose, and
 * deliberately NOT an MCP tool: redeeming a credit is a spend, and the
 * operator judged MCP exposure of a spend too risky. Agents that need it come
 * through this same route and are attributed by their capability header.
 *
 *   GET  /api/accounts/codex/reset-credits[?id=<account>[&live=1]]
 *        Availability per Codex account from the durable observation the
 *        controller keeps (or a live read for one account with `live=1`), plus
 *        the newest redemption records.
 *   POST /api/accounts/codex/reset-credits  { id, idempotencyKey? }
 *        Redeems ONE credit for the named account through that account's own
 *        app-server (the same backend call the Codex TUI makes), re-reads the
 *        limits, records the reading, and journals the attempt. No confirm
 *        step: the click is the decision (operator standing rule, #1418).
 *
 * Endpoint shapes pinned against codex-cli 0.151.0 are documented in the PR.
 */

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,128}$/;

function actorFor(req: NextRequest): ResetCreditActor {
  const caller = callerConversationId(req);
  return caller ? { kind: "agent", conversationId: caller } : { kind: "operator" };
}

function availabilityRow(account: CodexAccount, now: number) {
  const observation = agentRegistry().readOnlySnapshot().quotaObservations.codex[account.id];
  return {
    id: account.id,
    label: account.label,
    resetCredits: observation?.resetCredits ?? null,
    checkedAt: observation?.observedAt ?? null,
    ...(observation ? { limits: accountProjection(observation, account.authPresent, now).limits } : {}),
  };
}

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  const live = req.nextUrl.searchParams.get("live") === "1";
  const accounts = listCodexAccounts();
  if (id !== null) {
    const account = accounts.find((candidate) => candidate.id === id);
    if (!account) return NextResponse.json({ error: "Codex account is unavailable", code: "unknown_account" }, { status: 404 });
    if (live) {
      const result = await refreshAccountLimits("codex", account.id);
      if (result.kind === "probe_failed") return NextResponse.json({ error: "live limits read failed", code: "probe_failed", detail: result.detail }, { status: 502 });
    }
    return NextResponse.json({ accounts: [availabilityRow(account, Date.now())], redemptions: readResetCreditJournal().filter((entry) => entry.accountId === account.id) });
  }
  const now = Date.now();
  return NextResponse.json({ accounts: accounts.map((account) => availabilityRow(account, now)), redemptions: readResetCreditJournal() });
}

function journalEntry(
  account: CodexAccount,
  actor: ResetCreditActor,
  idempotencyKey: string,
  redemption: CodexResetCreditRedemption | null,
  detail: string | null,
  now: number,
): ResetCreditJournalEntry {
  return {
    at: new Date(now).toISOString(),
    engine: "codex",
    accountId: account.id,
    accountKind: account.kind,
    actor,
    idempotencyKey,
    outcome: redemption?.outcome ?? "consume_failed",
    refusedLocally: redemption?.refusedLocally ?? false,
    before: {
      availableCount: redemption?.before.resetCredits?.availableCount ?? null,
      window: governingWindowSummary(redemption?.before.rateLimits),
    },
    after: redemption
      ? { availableCount: redemption.after.resetCredits?.availableCount ?? null, window: governingWindowSummary(redemption.after.rateLimits) }
      : null,
    detail,
  };
}

export async function POST(req: NextRequest) {
  const rejected = rejectCrossOrigin(req);
  if (rejected) return rejected;
  let body: { id?: unknown; idempotencyKey?: unknown };
  try { body = await req.json() as { id?: unknown; idempotencyKey?: unknown }; } catch { return NextResponse.json({ error: "invalid JSON", code: "invalid_json" }, { status: 400 }); }
  if (typeof body.id !== "string" || !body.id.trim()) return NextResponse.json({ error: "id must be a string", code: "invalid_request" }, { status: 400 });
  if (body.idempotencyKey !== undefined && (typeof body.idempotencyKey !== "string" || !IDEMPOTENCY_KEY.test(body.idempotencyKey))) {
    return NextResponse.json({ error: "idempotencyKey must be 1-128 characters of [A-Za-z0-9._:-]", code: "invalid_request" }, { status: 400 });
  }
  const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : crypto.randomUUID();
  const account = listCodexAccounts().find((candidate) => candidate.id === body.id);
  if (!account) return NextResponse.json({ error: "Codex account is unavailable", code: "unknown_account" }, { status: 404 });
  const actor = actorFor(req);
  const now = Date.now();

  let redemption: CodexResetCreditRedemption;
  try {
    redemption = await managedCodexRuntime().redeemResetCredit(account, idempotencyKey);
  } catch (error) {
    const detail = redactAppServerDetail(error instanceof Error ? error.message : String(error));
    const recorded = appendResetCreditJournal(journalEntry(account, actor, idempotencyKey, null, detail, now));
    logEvent("reset-credit", { result: "error", reason: "consume_failed", meta: { accountId: account.id, actor: actor.kind, idempotencyKey, recorded } });
    return NextResponse.json({ error: "the reset credit could not be redeemed", code: "consume_failed", detail, recorded }, { status: 502 });
  }

  /* The post-redemption reading is recorded exactly like the controller's own,
     so the dialog, the capacity gate and the footer all see the new window. */
  const observation = recordLiveObservation(
    await codexObservationFromProbe(account, redemption.after, now),
    account.kind,
    { phase: "reset-credit-redeem", now },
  );
  const recorded = appendResetCreditJournal(journalEntry(account, actor, idempotencyKey, redemption, null, now));
  const redeemed = redemption.outcome === "reset" || redemption.outcome === "alreadyRedeemed";
  logEvent("reset-credit", {
    result: redeemed ? "ok" : "error",
    reason: redemption.outcome,
    meta: {
      accountId: account.id,
      actor: actor.kind,
      idempotencyKey,
      refusedLocally: redemption.refusedLocally,
      availableBefore: redemption.before.resetCredits?.availableCount ?? null,
      availableAfter: redemption.after.resetCredits?.availableCount ?? null,
      recorded,
    },
  });
  const projection = { id: account.id, ...accountProjection(observation, account.authPresent, now) };
  if (redemption.outcome === "noCredit") {
    return NextResponse.json({ error: "No usage limit resets available.", code: "no_resets_available", outcome: redemption.outcome, refusedLocally: redemption.refusedLocally, recorded, account: projection }, { status: 409 });
  }
  if (redemption.outcome === "nothingToReset") {
    return NextResponse.json({ error: "No rate-limit window is eligible for a reset.", code: "nothing_to_reset", outcome: redemption.outcome, recorded, account: projection }, { status: 409 });
  }
  return NextResponse.json({ outcome: redemption.outcome, redeemed: true, recorded, account: projection });
}
