"use client";

import type { RuntimeLiveTurnItem } from "@/lib/runtime/liveTurn";
import { useLocale } from "@/lib/i18n";
import { StreamingMd } from "@/components/feed/markdown";

/* A live row is the same message its transcript echo will carry a moment later,
   so it goes through the same markdown grammar — otherwise the text visibly
   changes appearance when the echo lands. While the item is still streaming,
   StreamingMd holds the unfinished tail as plain text instead of guessing at a
   construct whose closer has not arrived. */
export function LiveTurnRows({ items }: { items: readonly RuntimeLiveTurnItem[] }) {
  const { t } = useLocale();
  if (!items.length) return null;
  return (
    <div data-live-turn-group>
      {items.map((item, index) => (
        <div
          key={item.itemId ?? `${item.startedAt ?? "live"}:${index}`}
          data-live-turn
          data-live-turn-item-id={item.itemId ?? undefined}
          className="my-2 ml-9 whitespace-pre-wrap [overflow-wrap:anywhere] text-ui text-primary"
        >
          {item.omittedItems ? (
            <span data-live-turn-omitted-items className="text-muted">
              {`${t("feed.liveOmittedItems", {
                count: item.omittedItems,
                chars: item.omittedChars ?? 0,
              })}\n`}
            </span>
          ) : item.omittedChars ? (
            <span data-live-turn-omitted-chars className="text-muted">
              {`${t("feed.liveOmittedChars", { chars: item.omittedChars })}\n`}
            </span>
          ) : null}
          <StreamingMd text={item.text} streaming={item.phase === "streaming"} />
          {item.phase === "streaming" && index === items.length - 1 ? (
            <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse rounded-[2px] bg-accent align-text-bottom" aria-hidden />
          ) : null}
        </div>
      ))}
    </div>
  );
}
