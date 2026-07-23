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
  return feed.flatMap(({ item }) => {
    if (item.kind === "prose") {
      return [{
      sourceId: item.sourceId ?? null,
      text: item.text.trim(),
      at: timestamp(item.ts),
      }];
    }
    if (
      (item.kind === "review" || item.kind === "mem-citation" || item.kind === "blob")
      && item.sourceId
    ) {
      return [{
        sourceId: item.sourceId,
        text: "",
        at: item.kind === "review" ? timestamp(item.ts) : null,
      }];
    }
    return [];
  });
}

/**
 * Canonical transcript rows claim completed live items by response identity.
 * Older engine records without ids use a timestamp-fenced text echo.
 */
export interface RuntimeLiveTurnReconciliation {
  visible: RuntimeLiveTurnItem[];
  newlyOwnedItemIds: string[];
}

export function reconcileRuntimeLiveTurnItems(
  liveTurn: RuntimeLiveTurn | null | undefined,
  feed: readonly FeedEntry[],
  canonicalAssistantItemIds: readonly string[] = [],
): RuntimeLiveTurnReconciliation {
  const canonical = canonicalAssistantItems(feed);
  const visibleSourceIds = new Set(canonical.flatMap((item) => item.sourceId ? [item.sourceId] : []));
  for (const sourceId of canonicalAssistantItemIds) {
    if (!visibleSourceIds.has(sourceId)) canonical.push({ sourceId, text: "", at: null });
  }
  const claimed = new Set<number>();
  const newlyOwnedItemIds: string[] = [];
  const visible = runtimeLiveTurnItems(liveTurn).filter((live) => {
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
    if (live.itemId) newlyOwnedItemIds.push(live.itemId);
    return false;
  });
  return { visible, newlyOwnedItemIds };
}

export function visibleRuntimeLiveTurnItems(
  liveTurn: RuntimeLiveTurn | null | undefined,
  feed: readonly FeedEntry[],
): RuntimeLiveTurnItem[] {
  return reconcileRuntimeLiveTurnItems(liveTurn, feed).visible;
}
