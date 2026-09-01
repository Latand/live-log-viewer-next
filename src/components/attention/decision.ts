import { roleNameById } from "@/components/builderCopy";
import { rateLimitText } from "@/components/rateLimit";
import type { Locale, TFunction } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

import { attentionId, blockingStuckDelivery, openBridgeAsk, stalledAttention } from "../attention";

/**
 * The ONE line every attention surface shows for a waiting agent (issue #1167).
 *
 * The dock badge, the toast and the island popover all answer the same
 * question — «what do you owe this agent?» — and each used to answer it in its
 * own words: the toast said «Agent is waiting for a reply» and named no
 * decision at all, while the popover derived a snippet of its own. Three
 * parallel strings over one signal is how a toast and a badge start describing
 * different things, so the derivation lives here once and every surface reads
 * it.
 *
 * `attentionId` is the eligibility authority, and this module CALLS it rather
 * than re-deciding: a conversation the queue does not count is a conversation
 * this line refuses to name. That gate is load-bearing for the stalled tier,
 * whose signal needs a live process and a fresh mtime before it is anyone's to
 * answer — without it a toast left up over an abandoned session announced
 * «interrupted or awaiting permission» while the popover behind it held no such
 * row, which is the one-signal-two-descriptions defect this issue exists to
 * remove.
 */

/** The role a pipeline stage records when its stage carries no role at all
    (`engine.ts` writes `roleId ?? "agent"`). It is the ABSENCE of a role
    spelled as a word, so it attributes nothing and never reaches the line. */
const UNNAMED_ROLE = "agent";

/**
 * Who is waiting, when the conversation's evidence names a role.
 *
 * The same fail-open ladder the registry walks in `conversationAgentRole`: the
 * conversation's own role first (`durableLineage.role` already collapses the
 * launch receipt's `agentRole` and the durable spawn edge behind it), then its
 * newest container membership — the read model keeps memberships in the order
 * the registry appended them, so the last row is the newest. A stage slot is
 * real evidence of the job an agent was given; dropping it left a pipeline
 * builder's question attributed to nobody.
 */
function roleLabel(t: TFunction, file: FileEntry): string | null {
  const lineage = file.durableLineage;
  const seat = lineage?.memberships.findLast((membership) => {
    const named = membership.role.trim();
    return named !== "" && named !== UNNAMED_ROLE;
  });
  const role = lineage?.role?.trim() || seat?.role.trim();
  return role ? roleNameById(t, role) : null;
}

/**
 * The wait itself, from a FIXED vocabulary — the agent's own question header,
 * or one of three localized phrases, or the rate-limit badge's own wording.
 *
 * Nothing is lifted out of a question body or off a scraped screen: a line
 * assembled from whatever the terminal happened to be drawing names the OPTIONS
 * rather than the decision, and it is what put «❯ 1. Yes» in front of the
 * operator as the name of a wait.
 *
 * The ladder is `attentionId`'s precedence, in its order, over a file that
 * already qualified — which is what makes the stalled tail honest rather than a
 * catch-all.
 */
function decisionText(t: TFunction, locale: Locale, file: FileEntry, now: number): string {
  /* First, exactly as `attentionId` orders it (issue #1168): an orchestrator's
     open bridge ask is the one wait on this board that was ESCALATED rather
     than inferred, so it outranks whatever the seat's own transcript is doing.
     An ask the clock has already retired falls THROUGH to the signals below,
     so the words age out with the row they belong to. */
  if (openBridgeAsk(file, now)) return t("status.awaitingDecision");
  const pending = file.pendingQuestion;
  if (pending) {
    if (pending.kind === "plan") return t("attention.decisionPlan");
    /* Never the question BODY: it is a paragraph written to be read inside the
       conversation, and it truncates into nonsense on a badge. */
    return pending.questions?.[0]?.header?.trim() || t("attention.decisionQuestion");
  }
  if (file.rateLimit) return rateLimitText(t, locale, file.rateLimit);
  if (file.waitingInput) return t("attention.decisionPermission");
  if (stalledAttention(file, now)) return t("status.stalled");
  if (blockingStuckDelivery(file, now) !== null) return t("attention.decisionDelivery");
  return t("status.stalled");
}

/**
 * The decision a conversation owes the operator, plus its role when the
 * evidence names one — or null when the queue counts no wait here at all.
 *
 * A surface holding a stale target (a toast still up after its question was
 * answered elsewhere, an agent that exited mid-turn) falls back to its own
 * generic wording rather than inventing a decision. `now` is epoch SECONDS and
 * defaults to the wall clock, exactly as `attentionId` does.
 */
export function decisionLine(t: TFunction, locale: Locale, file: FileEntry, now: number = Date.now() / 1000): string | null {
  if (attentionId(file, now) === null) return null;
  const decision = decisionText(t, locale, file, now);
  const role = roleLabel(t, file);
  return role ? `${decision} · ${role}` : decision;
}
