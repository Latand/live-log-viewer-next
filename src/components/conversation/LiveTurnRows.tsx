"use client";

import { useMemo } from "react";

import type { RuntimeLiveTurnItem, RuntimeLiveTurnTool } from "@/lib/runtime/liveTurn";
import { useLocale } from "@/lib/i18n";
import { GlyphIcon } from "@/components/icons";
import { hhmm } from "@/components/utils";
import { StatusIcon } from "@/components/feed/cards/shared";
import { elapsedDurationMs, formatDuration } from "@/components/feed/duration";
import { StreamingMd } from "@/components/feed/markdown";
import { summarizeTool } from "@/components/feed/tools";

/* A Codex file change arrives on the event stream as a header-only patch (the
   file list, no hunks): the shared summarizer counts changed lines and has none
   to show, so the row names the touched files instead of a bare "Edit". */
const PATCH_FILE_RE = /^\*{0,3}\s*(?:Add|Update|Delete) File:\s*(.+)$/;
function patchFileNames(input: unknown): string {
  if (typeof input !== "string") return "";
  const names = input.split("\n").flatMap((line) => {
    const match = line.match(PATCH_FILE_RE);
    if (!match) return [];
    const filePath = match[1]!.trim().replace(/[/\\]+$/, "");
    return [filePath.split(/[/\\]/).pop() || filePath];
  });
  return names.slice(0, 4).join(", ") + (names.length > 4 ? ", …" : "");
}

/* A live tool row is the same call its transcript echo will carry a moment
   later, so it reads through the same summarizer and the same quiet ToolLine
   grammar (glyph · summary · non-ok status · duration · time) — the row must not change
   appearance when the canonical card replaces it. It has no body: the call's
   output lives in the transcript, and this row only says the call happened,
   is running, or failed. */
function LiveToolRow({ item, tool }: { item: RuntimeLiveTurnItem; tool: RuntimeLiveTurnTool }) {
  const { t } = useLocale();
  const summary = useMemo(() => summarizeTool(tool.name, tool.args, tool.engine), [tool.name, tool.args, tool.engine]);
  const isErr = tool.status === "err";
  /* `unknown` is a finished call whose result the journal's bound could not
     retain: no spinner (it is not running), no check (its outcome is not
     known), just the word for what happened to it. */
  const label = tool.status === "run"
    ? t("render.executing")
    : tool.status === "err"
      ? t("render.error")
      : tool.status === "unknown"
        ? t("feed.liveToolOutcomeOmitted")
        : "";
  const files = tool.name === "apply_patch" && !summary.chips.length ? patchFileNames(tool.args.input) : "";
  const base = files ? `${summary.summary} · ${files}` : summary.summary;
  const detail = tool.argsOmitted ? `${base} · ${t("feed.liveToolArgsOmitted")}` : base;
  const time = hhmm(item.startedAt ?? item.completedAt ?? undefined);
  const durationMs = elapsedDurationMs(item.startedAt, item.completedAt);
  const duration = durationMs === null ? "" : formatDuration(durationMs);
  return (
    <div
      data-live-turn
      data-live-turn-item-id={item.itemId ?? undefined}
      data-live-tool={tool.name}
      data-live-tool-status={tool.status}
      className={`ml-9 flex items-center gap-2 rounded-control py-0.5 text-ui ${
        isErr ? "border-l-2 border-danger bg-danger-soft pl-2 pr-1 text-danger" : "text-muted"
      }`}
    >
      <GlyphIcon name={summary.icon} className="h-3.5 w-3.5 shrink-0" />
      <span className={`min-w-0 flex-1 truncate ${isErr ? "font-semibold" : "text-secondary"}`} title={detail}>
        {detail}
      </span>
      {tool.status !== "ok" ? (
        <span className={`inline-flex shrink-0 items-center gap-1 text-caption font-semibold ${isErr ? "text-danger" : "text-muted"}`}>
          {tool.status !== "unknown" ? <StatusIcon status={tool.status} className="h-3 w-3" /> : null}
          {label}
        </span>
      ) : null}
      {duration ? <span className="shrink-0 text-caption tabular-nums text-muted">{duration}</span> : null}
      {time ? <span className="shrink-0 text-caption tabular-nums text-muted">{time}</span> : null}
    </div>
  );
}

/* A live prose row is the same message its transcript echo will carry a moment
   later, so it goes through the same markdown grammar — otherwise the text
   visibly changes appearance when the echo lands. While the item is still
   streaming, StreamingMd holds the unfinished tail as plain text instead of
   guessing at a construct whose closer has not arrived. Tool rows interleave
   with prose in response order (issue #1100), each rendered by LiveToolRow. */
export function LiveTurnRows({ items }: { items: readonly RuntimeLiveTurnItem[] }) {
  const { t } = useLocale();
  if (!items.length) return null;
  return (
    <div data-live-turn-group>
      {items.map((item, index) => {
        if (item.tool) {
          return <LiveToolRow key={item.itemId ?? `${item.startedAt ?? "live"}:${index}`} item={item} tool={item.tool} />;
        }
        return (
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
        );
      })}
    </div>
  );
}
