"use client";

import type { RuntimeLiveTurnItem } from "@/lib/runtime/liveTurn";
import { useLocale } from "@/lib/i18n";
import { GlyphIcon } from "@/components/icons";
import { StreamingMd } from "@/components/feed/markdown";
import { summarizeTool } from "@/components/feed/tools";

function toolArgs(item: RuntimeLiveTurnItem): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(item.text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

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
          key={item.rowId ?? `${item.itemId ?? item.startedAt ?? "live"}:${index}`}
          data-live-turn
          data-live-turn-item-id={item.itemId ?? undefined}
          data-live-turn-tool={item.kind === "tool" ? item.toolName : undefined}
          className={item.kind === "tool"
            ? "my-0.5 ml-9 flex min-w-0 items-center gap-2 rounded-control py-0.5 text-ui text-muted"
            : "my-2 ml-9 whitespace-pre-wrap [overflow-wrap:anywhere] text-ui text-primary"}
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
          {item.kind === "tool" ? (() => {
            const toolName = item.toolName || "tool";
            const summary = summarizeTool(
              toolName,
              toolArgs(item),
              item.toolEngine === "claude" ? "claude" : "codex",
            );
            return (
              <>
                <GlyphIcon name={summary.icon} className="h-3.5 w-3.5 shrink-0" />
                <span className="shrink-0 font-mono text-caption text-muted">{toolName}</span>
                {summary.summary !== toolName ? <span aria-hidden className="shrink-0 text-muted">·</span> : null}
                <span className="min-w-0 flex-1 truncate text-secondary" title={summary.summary}>
                  {summary.summary !== toolName ? summary.summary : ""}
                </span>
              </>
            );
          })() : <StreamingMd text={item.text} streaming={item.phase === "streaming"} />}
          {item.phase === "streaming" && (item.kind === "tool" || index === items.length - 1) ? (
            <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse rounded-[2px] bg-accent align-text-bottom" aria-hidden />
          ) : null}
        </div>
      ))}
    </div>
  );
}
