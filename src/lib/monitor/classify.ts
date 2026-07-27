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
 * The best correlated item, or null when nothing clears the ambiguity floor.
 * A card the monitor itself created for this exact request wins outright — it
 * is the same request by construction, whatever the wording drifted to.
 */
export function matchEvidence(request: OperatorRequest, evidence: readonly EvidenceItem[]): EvidenceMatch | null {
  const own = evidence.find((item) => item.monitorRef && item.monitorRef === request.fingerprint);
  if (own) return { item: own, score: 1 };

  if (request.references.length > 0) {
    const referenced = evidence.find((item) => item.references.some((value) => request.references.includes(value)));
    if (referenced) return { item: referenced, score: 1 };
  }

  const requestTokens = tokens(`${request.title} ${request.text}`);
  let best: EvidenceMatch | null = null;
  for (const item of evidence) {
    const score = overlapScore(requestTokens, tokens(item.title));
    if (score < AMBIGUOUS_SCORE) continue;
    if (!best || score > best.score) best = { item, score };
  }
  return best;
}

function stateFromEvidence(match: EvidenceMatch, options: ClassifyOptions): { state: RequestState; reason: string } {
  const { item } = match;
  if (item.state === "terminal") {
    return { state: "completed", reason: `${item.kind} ${item.id} reached a terminal state` };
  }
  if (item.state === "inert") {
    return { state: "stalled", reason: `${item.kind} ${item.id} is parked` };
  }
  const stallAfterMs = options.stallAfterMs ?? DEFAULT_STALL_AFTER_MS;
  const updatedAt = item.updatedAt ? Date.parse(item.updatedAt) : NaN;
  if (Number.isFinite(updatedAt) && options.now.getTime() - updatedAt > stallAfterMs) {
    return { state: "stalled", reason: `${item.kind} ${item.id} is live but shows no movement past the stall threshold` };
  }
  const owner = item.owner ? ` owned by ${item.owner}` : " with no owner picked up yet";
  return { state: "in-flight", reason: `${item.kind} ${item.id} is live${owner}` };
}

export function classifyRequest(
  request: OperatorRequest,
  evidence: readonly EvidenceItem[],
  options: ClassifyOptions,
): ClassifiedRequest {
  const match = matchEvidence(request, evidence);

  if (match && (match.score >= MATCH_SCORE || match.item.monitorRef === request.fingerprint)) {
    const { state, reason } = stateFromEvidence(match, options);
    const owned = match.item.monitorRef === request.fingerprint;
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
