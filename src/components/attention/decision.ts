import { roleNameById } from "@/components/builderCopy";
import { formatRateLimitTime } from "@/components/rateLimit";
import type { Locale, TFunction } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

/**
 * What a waiting agent is actually blocked on, and the ONE line that says it
 * (issue #1167).
 *
 * The dock badge, the toast and the island popover all answer the same
 * question — «what do you owe this agent?» — and each used to answer it in its
 * own words: the toast said «Agent is waiting for a reply» and named no
 * decision at all, while the popover derived a snippet of its own. Three
 * parallel strings over one signal is how a toast and a badge start describing
 * different things, so the derivation lives here once and every surface reads
 * it.
 *
 * The precedence below MIRRORS `attentionId`'s, deliberately and in the same
 * order: the surface that NAMES a wait has to be talking about the signal the
 * queue COUNTED. `attentionId` stays the only authority on whether a
 * conversation is waiting at all (a stalled transcript needs a live process and
 * a fresh mtime before it counts) — this module only names what it found, so a
 * caller asks the queue first and asks for words second.
 */
export type AttentionDecision =
  /** A structured question: `header` is the agent's own label for it. */
  | { kind: "question"; header: string | null }
  /** A plan awaiting approval. */
  | { kind: "plan" }
  /** An engine or account wall, with the reset moment when one was reported. */
  | { kind: "rate-limit"; resetAt: number | null }
  /** A terminal prompt, named by whatever the screen gave up. */
  | { kind: "permission"; prompt: string | null }
  /** An interrupted turn — no question on screen, but nobody is working. */
  | { kind: "stalled" };

/** First non-empty line of a scraped block, tidied for a one-line surface. */
function firstLine(text: string | null | undefined): string | null {
  if (!text) return null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line) return line;
  }
  return null;
}

/**
 * The decision a conversation is blocked on, or null when it carries no signal.
 *
 * Precedence, identical to `attentionId`'s: a structured question, then a
 * rate-limit wall, then the screen-scrape fallback, then the stalled state.
 */
export function attentionDecision(file: FileEntry): AttentionDecision | null {
  const pending = file.pendingQuestion;
  if (pending) {
    if (pending.kind === "plan") return { kind: "plan" };
    const first = pending.questions?.[0];
    return { kind: "question", header: firstLine(first?.header) ?? firstLine(first?.question) };
  }
  if (file.rateLimit) return { kind: "rate-limit", resetAt: file.rateLimit.resetAt };
  const waiting = file.waitingInput;
  if (waiting) return { kind: "permission", prompt: firstLine(waiting.menu?.question) ?? firstLine(waiting.screenTail) };
  if (file.activity === "stalled") return { kind: "stalled" };
  return null;
}

/** The decision alone, without attribution. */
function decisionText(t: TFunction, locale: Locale, decision: AttentionDecision): string {
  switch (decision.kind) {
    case "question":
      return decision.header ?? t("attention.decisionQuestion");
    case "plan":
      return t("attention.decisionPlan");
    case "rate-limit":
      /* The wording the rate-limit badge already uses, so the wall reads the
         same wherever the operator meets it. */
      return decision.resetAt
        ? t("rateLimit.badgeUntil", { time: formatRateLimitTime(decision.resetAt, locale) })
        : t("rateLimit.badge");
    case "permission":
      return decision.prompt ?? t("attention.decisionPermission");
    case "stalled":
      return t("status.stalled");
  }
}

/**
 * Who is waiting, when the conversation carries a durable role.
 *
 * Only the conversation's OWN role counts (`durableLineage.role` — the launch
 * receipt's `agentRole`, or the durable spawn edge behind it). Container
 * memberships are deliberately not consulted: a stage slot names the agent's
 * place in a pipeline rather than the job it is doing, and «Member» beside a
 * decision tells the operator nothing they did not already know.
 */
function roleLabel(t: TFunction, file: FileEntry): string | null {
  const role = file.durableLineage?.role;
  return role ? roleNameById(t, role) : null;
}

/**
 * The one line every attention surface shows: the decision, plus the agent's
 * role when the conversation names one. Null when there is no signal to name —
 * a surface with a stale target (a toast still up after its question was
 * answered elsewhere) falls back to its own generic wording rather than
 * inventing a decision.
 */
export function decisionLine(t: TFunction, locale: Locale, file: FileEntry): string | null {
  const decision = attentionDecision(file);
  if (!decision) return null;
  const role = roleLabel(t, file);
  const text = decisionText(t, locale, decision);
  return role ? `${text} · ${role}` : text;
}
