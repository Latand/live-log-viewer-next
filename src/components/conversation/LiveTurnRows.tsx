"use client";

import type { RuntimeLiveTurnItem } from "@/lib/runtime/liveTurn";

export function LiveTurnRows({ items }: { items: readonly RuntimeLiveTurnItem[] }) {
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
          {item.text}
          {item.phase === "streaming" && index === items.length - 1 ? (
            <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse rounded-[2px] bg-accent align-text-bottom" aria-hidden />
          ) : null}
        </div>
      ))}
    </div>
  );
}
