import { globalCache } from "@/lib/scanner/caches";
import type { FileEntry } from "@/lib/types";

import { lastAssistantMessage, parseFindings } from "./findings";
import type { ReviewVerdict } from "./types";

/**
 * Terminal outcome of a one-shot reviewer transcript (issue #325).
 *
 * Direct /api/spawn reviewers have no flow engine watching them, so the files
 * projection derives their verdict straight from the transcript's last
 * assistant message — the exact fallback contract the flow engine already uses
 * (findings.ts). The reviewer role contract also allows a bare "NO FINDINGS"
 * reply for clean work (roles/defaults.ts); that projects as APPROVE with zero
 * findings so the existing verdict-chip grammar covers it.
 */
export interface ReviewOutcome {
  verdict: ReviewVerdict;
  findingsCount: number | null;
  observedAt: string | null;
}

/** "NO FINDINGS" as its own line/statement, not as part of a longer sentence
    like "no findings yet" — the role contract asks for the exact phrase. */
const NO_FINDINGS_RE = /^\s*[*_`#-]*\s*NO\s+FINDINGS\b/im;

const outcomeCache = globalCache<[number, ReviewOutcome | null]>("review-outcome");

type TranscriptEntry = Pick<FileEntry, "path" | "root" | "size" | "mtime">;

/** Review outcome of a reviewer transcript, cached by size like the sibling
    tail derivations (plan, context, last turn). */
export function reviewOutcomeFor(entry: TranscriptEntry): ReviewOutcome | null {
  if (entry.root !== "claude-projects" && entry.root !== "codex-sessions") return null;
  const cached = outcomeCache.get(entry.path);
  if (cached?.[0] === entry.size) return cached[1];

  let outcome: ReviewOutcome | null = null;
  const message = lastAssistantMessage(entry);
  if (message) {
    const observedAt = Number.isFinite(message.ts) ? new Date(message.ts).toISOString() : null;
    const parsed = parseFindings(message.text);
    if (parsed) outcome = { verdict: parsed.verdict, findingsCount: parsed.findingsCount, observedAt };
    else if (NO_FINDINGS_RE.test(message.text)) outcome = { verdict: "APPROVE", findingsCount: 0, observedAt };
  }
  outcomeCache.set(entry.path, [entry.size, outcome]);
  return outcome;
}
