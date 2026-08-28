import type { ClassifiedRequest, EvidenceItem, EvidenceMatch, OperatorRequest, RequestState } from "./types";

/**
 * Correlating an operator request with the work the machine already tracks
 * (issue #741), as a pure function of two lists.
 *
 * The scoring is deliberately blunt — shared meaningful words, plus an exact
 * issue/PR reference as a trump card. A smarter matcher would be a better
 * matcher, but this one has to be explainable: every card the monitor creates
 * is a claim that nothing correlated, and the operator has to be able to see
 * why from the numbers.
 */

/** Above this, a correlation is taken as the answer. */
const MATCH_SCORE = 0.5;
/** Between this and {@link MATCH_SCORE}, the monitor refuses to decide. */
const AMBIGUOUS_SCORE = 0.3;
/** Active evidence that has not moved for this long is treated as stalled. */
export const DEFAULT_STALL_AFTER_MS = 48 * 60 * 60 * 1000;

/* Words that carry no discriminating signal in a request or a card title.
   Both languages the operator works in are covered; an unstopped list makes
   every request correlate with every card through "the", "и" and "please". */
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "for", "with", "when", "that", "this", "those", "these", "into", "from",
  "please", "pls", "add", "make", "need", "needs", "should", "would", "could", "can", "you", "your", "our", "its",
  "it", "is", "are", "was", "were", "be", "been", "do", "does", "did", "not", "no", "on", "in", "of", "to", "at",
  "by", "as", "so", "if", "then", "than", "there", "here", "now", "все", "еще", "уже", "или", "как", "что", "это",
  "для", "надо", "нужно", "пожалуйста", "чтобы", "если", "тоже", "там", "тут", "щоб", "тільки", "треба",
]);

function tokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.normalize("NFKC").toLowerCase().split(/[^\p{L}\p{N}#]+/u)) {
    const token = raw.replace(/^#+/, "");
    if (token.length < 3 || STOPWORDS.has(token)) continue;
    out.add(token);
  }
  return out;
}

/**
 * Overlap of the two token sets against the smaller one, so a short card title
 * ("Deploy script retry") still correlates fully with a long request that
 * contains it. Symmetric coverage would punish exactly the case the monitor
 * cares about most.
 */
function overlapScore(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / Math.min(left.size, right.size);
}

export interface ClassifyOptions {
  now: Date;
  /** Overrides {@link DEFAULT_STALL_AFTER_MS}. */
  stallAfterMs?: number;
}

/**
 * Whether this item is even allowed to answer for this request.
 *
 * Correlation is project-scoped: another board's card must never suppress a
 * request made here, and the fingerprint of a request says nothing about which
 * project it belongs to. Repository-wide sources (pull requests, issues) carry
 * no project and are admitted only for an explicit reference, where the
 * operator named the number themselves.
 */
function eligible(request: OperatorRequest, item: EvidenceItem, viaReference: boolean): boolean {
  if (item.project === null) return viaReference;
  return item.project === request.project;
}

/**
 * The best correlated item, or null when nothing clears the ambiguity floor.
 *
 * A card the monitor itself created for this exact request wins outright — it
 * is the same request by construction, whatever the wording drifted to.
 *
 * An explicit `#N` ranks next, but it is not self-evidently about the request:
 * "finish the exporter before #741 lands" names an issue in passing. So a
 * reference match reports whether wording corroborates it, and the classifier
 * refuses to draw a terminal conclusion from an uncorroborated one.
 */
export function matchEvidence(request: OperatorRequest, evidence: readonly EvidenceItem[]): EvidenceMatch | null {
  const own = evidence.find((item) => item.monitorRef && item.monitorRef === request.fingerprint);
  if (own) return { item: own, score: 1, basis: "monitor-ref" };

  const requestTokens = tokens(`${request.title} ${request.text}`);

  if (request.references.length > 0) {
    const referenced = evidence.find((item) =>
      item.references.some((value) => request.references.includes(value)) && eligible(request, item, true));
    if (referenced) {
      const corroboration = overlapScore(requestTokens, tokens(referenced.title));
      return {
        item: referenced,
        score: corroboration,
        basis: corroboration >= AMBIGUOUS_SCORE ? "reference" : "contextual-reference",
      };
    }
  }

  let best: EvidenceMatch | null = null;
  for (const item of evidence) {
    if (!eligible(request, item, false)) continue;
    const score = overlapScore(requestTokens, tokens(item.title));
    if (score < AMBIGUOUS_SCORE) continue;
    if (!best || score > best.score) best = { item, score, basis: "wording" };
  }
  return best;
}

/**
 * Whether tracked work has stopped moving, and the clause that says so — or
 * null when it is still in flight.
 *
 * The one stall rule in the codebase, shared by request classification here and
 * by the seat tick's pre-check (#1245), which asks the same question of a
 * pipeline on a different threshold. Two properties travel with it: parked is
 * stalled outright, and an item with no movement evidence is never called
 * stalled — an unknown instant is not an old one.
 */
export function evidenceStallReason(
  item: Pick<EvidenceItem, "kind" | "id" | "state" | "updatedAt">,
  options: ClassifyOptions,
): string | null {
  if (item.state === "terminal") return null;
  if (item.state === "inert") return `${item.kind} ${item.id} is parked`;
  const stallAfterMs = options.stallAfterMs ?? DEFAULT_STALL_AFTER_MS;
  const updatedAt = item.updatedAt ? Date.parse(item.updatedAt) : NaN;
  if (Number.isFinite(updatedAt) && options.now.getTime() - updatedAt > stallAfterMs) {
    return `${item.kind} ${item.id} is live but shows no movement past the stall threshold`;
  }
  return null;
}

function stateFromEvidence(match: EvidenceMatch, options: ClassifyOptions): { state: RequestState; reason: string } {
  const { item } = match;
  if (item.state === "terminal") {
    return { state: "completed", reason: `${item.kind} ${item.id} reached a terminal state` };
  }
  const stalled = evidenceStallReason(item, options);
  if (stalled) return { state: "stalled", reason: stalled };
  const owner = item.owner ? ` owned by ${item.owner}` : " with no owner picked up yet";
  return { state: "in-flight", reason: `${item.kind} ${item.id} is live${owner}` };
}

export function classifyRequest(
  request: OperatorRequest,
  evidence: readonly EvidenceItem[],
  options: ClassifyOptions,
): ClassifiedRequest {
  const match = matchEvidence(request, evidence);

  /* A reference named in passing is the one match that must never conclude
     anything on its own — least of all `completed`, which would retire a
     request nobody worked on because the operator mentioned a closed issue
     while asking for something else. */
  if (match?.basis === "contextual-reference") {
    return {
      request,
      state: "awaiting-confirmation",
      match,
      reason: `names ${match.item.kind} ${match.item.id} in passing, with nothing else agreeing — too thin to call`,
    };
  }

  if (match && (match.basis === "monitor-ref" || match.basis === "reference" || match.score >= MATCH_SCORE)) {
    const { state, reason } = stateFromEvidence(match, options);
    const owned = match.basis === "monitor-ref";
    return { request, state, match, reason: owned ? `already on the board as ${match.item.id}; ${reason}` : reason };
  }

  if (match) {
    return {
      request,
      state: "awaiting-confirmation",
      match,
      reason: `possibly covered by ${match.item.kind} ${match.item.id}, correlation too weak to call`,
    };
  }

  if (request.asksForGithubIssue) {
    return {
      request,
      state: "awaiting-confirmation",
      match: null,
      reason: "asks for a GitHub issue; issues are never created from inferred intent, so this waits for an explicit confirmation",
    };
  }

  return { request, state: "untracked", match: null, reason: "no card, pipeline, flow, pull request or issue correlates" };
}
