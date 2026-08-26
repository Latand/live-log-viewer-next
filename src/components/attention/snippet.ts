import type { TFunction } from "@/lib/i18n";

import { openBridgeAsk, type AttentionItem } from "../attention";

/**
 * One-line reason a queue item waits, for every shared attention surface: the
 * orchestrator's own ask, a question header, a screen tail, or the stalled
 * wording.
 *
 * It lives beside the queue rather than inside a page component because the
 * words have to follow the same precedence `attentionId` enqueued the row
 * under. When those two drift, a row says one thing and counts as another —
 * and an expired bridge ask (#1168) is exactly that case: the queue has already
 * fallen through to the file's own signal, so the wording must fall through
 * with it rather than keep announcing a decision nobody is waiting on.
 */
export function attentionSnippet(t: TFunction, item: AttentionItem, now: number = Date.now() / 1000): string {
  if (openBridgeAsk(item.file, now)) return t("status.awaitingDecision");
  const q = item.file.pendingQuestion;
  if (q) {
    if (q.kind === "plan") return t("status.awaitingPlan");
    const first = q.questions?.[0];
    return first?.header || first?.question.split("\n")[0] || t("status.awaitingAnswer");
  }
  if (item.file.rateLimit) return t("status.rateLimited");
  const w = item.file.waitingInput;
  if (w) return w.menu?.question.split("\n")[0] || w.screenTail || t("status.awaitingTerminal");
  return t("status.stalled");
}
