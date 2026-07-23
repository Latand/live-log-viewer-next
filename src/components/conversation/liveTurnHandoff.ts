import type { FeedEntry } from "@/components/feed/parse";
import {
  runtimeLiveTurnItems,
  type RuntimeLiveTurn,
  type RuntimeLiveTurnItem,
} from "@/lib/runtime/liveTurn";

interface CanonicalAssistantItem {
  sourceId: string | null;
  text: string;
  at: number | null;
}

function timestamp(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function canonicalAssistantItems(feed: readonly FeedEntry[]): CanonicalAssistantItem[] {
  return feed.flatMap(({ item }) => item.kind === "prose"
    ? [{
      sourceId: item.sourceId ?? null,
      text: item.text.trim(),
      at: timestamp(item.ts),
    }]
    : []);
}

/**
 * Canonical transcript rows claim completed live items by response identity.
 * Older engine records without ids use a timestamp-fenced text echo.
 */
export function visibleRuntimeLiveTurnItems(
  liveTurn: RuntimeLiveTurn | null | undefined,
  feed: readonly FeedEntry[],
): RuntimeLiveTurnItem[] {
  const canonical = canonicalAssistantItems(feed);
  const claimed = new Set<number>();
  return runtimeLiveTurnItems(liveTurn).filter((live) => {
    if (live.phase === "streaming") return true;
    let owner = live.itemId
      ? canonical.findIndex((item, index) => !claimed.has(index) && item.sourceId === live.itemId)
      : -1;
    if (owner < 0 && !live.itemId) {
      const startedAt = timestamp(live.startedAt);
      owner = canonical.findIndex((item, index) =>
        !claimed.has(index)
        && item.text === live.text.trim()
        && (startedAt === null || item.at === null || item.at >= startedAt),
      );
    }
    if (owner < 0) return true;
    claimed.add(owner);
    return false;
  });
}
