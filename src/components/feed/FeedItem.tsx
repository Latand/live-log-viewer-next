"use client";

import { memo } from "react";

import { Brain, ChevronUp, Command, Check, Mail, Sparkle, X } from "../icons";
import { hhmm } from "../utils";
import { CopyButton } from "./CopyButton";
import { InboxImageCard } from "./InboxImage";
import { md, mdBlocks } from "./markdown";
import { tr, type Item } from "./parse";
import { BlobCard } from "./cards/BlobCard";
import { CmdGroupCard } from "./cards/CmdGroupCard";
import { CompactBand } from "./cards/CompactBand";
import { ImageCard } from "./cards/ImageCard";
import { MemCitationCard } from "./cards/MemCitationCard";
import { ProtocolMessageBody, parseProtocolPayload } from "./cards/ProtocolMessage";
import { ReviewCard } from "./cards/ReviewCard";
import { SysMsgCard } from "./cards/SysMsgCard";
import { ToolCard } from "./cards/ToolCard";
import { SpeakButton } from "./SpeakButton";

/* Memoized: feed items are immutable after buildFeed, so a pane re-render
   (poll tick, camera state, files refresh) skips re-parsing markdown for
   every message that did not change. */
export const FeedItem = memo(function FeedItem({ item, speakText }: { item: Item; speakText?: string }) {
  if (item.kind === "image") return <ImageCard media={item.media} data={item.data} w={item.w} h={item.h} bytes={item.bytes} />;
  if (item.kind === "inbox-image") return <InboxImageCard name={item.name} path={item.path} />;
  if (item.kind === "blob") return <BlobCard bytes={item.bytes} text={item.text} />;
  if (item.kind === "sysmsg") return <SysMsgCard label={item.label} text={item.text} />;
  if (item.kind === "compact") return <CompactBand item={item} />;
  if (item.kind === "review") return <ReviewCard item={item} />;
  if (item.kind === "mem-citation") return <MemCitationCard item={item} />;
  if (item.kind === "prose") {
    const cls = item.engine === "codex" ? "bg-codex" : "bg-claude";
    const AvatarIcon = item.engine === "codex" ? Command : Sparkle;
    return (
      <div className="group/msg my-3 flex gap-2.5">
        <div className={`mt-1 flex h-6.5 w-6.5 shrink-0 items-center justify-center rounded-full text-white ${cls}`}>
          <AvatarIcon className="h-3.5 w-3.5" aria-hidden />
        </div>
        <div className="relative min-w-0 flex-1 whitespace-pre-wrap break-words">
          {hhmm(item.ts) ? <div className="mb-0.5 text-label tabular-nums text-dim">{hhmm(item.ts)}</div> : null}
          <div className="absolute right-0 top-0 flex items-center gap-0.5">
            {speakText ? <SpeakButton text={speakText} /> : null}
            <CopyButton
              text={item.text}
              label={tr("feed.copyMd")}
              className="opacity-0 transition-opacity focus-visible:opacity-100 group-hover/msg:opacity-100 [@media(hover:none)]:opacity-60"
            />
          </div>
          {mdBlocks(item.text)}
        </div>
      </div>
    );
  }
  if (item.kind === "user") {
    const long = item.text.length > 500;
    return (
      <div className="group/msg my-3 flex items-start justify-end gap-1.5">
        <CopyButton
          text={item.text}
          label={tr("feed.copyMd")}
          className="mt-2 opacity-0 transition-opacity focus-visible:opacity-100 group-hover/msg:opacity-100 [@media(hover:none)]:opacity-60"
        />
        <div className="max-w-[75%] whitespace-pre-wrap break-words rounded-surface bg-user px-4 py-2.5">
          {long ? (
            <details className="group/usr">
              <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
                <span className="group-open/usr:hidden">
                  {item.text.slice(0, 180)}… <span className="font-semibold text-accent">({tr("common.chars", { n: item.text.length })})</span>
                </span>
                <span className="hidden items-center gap-1 text-[11px] font-semibold text-dim group-open/usr:inline-flex">
                  {tr("common.collapse")} <ChevronUp className="h-3 w-3" aria-hidden />
                </span>
              </summary>
              {mdBlocks(item.text)}
            </details>
          ) : (
            mdBlocks(item.text)
          )}
        </div>
      </div>
    );
  }
  if (item.kind === "tool") return <ToolCard event={item} />;
  if (item.kind === "cmd-group") return <CmdGroupCard item={item} />;
  if (item.kind === "tmsg") {
    const protocol = parseProtocolPayload(item.text);
    const long = item.text.length > 420 || item.text.split("\n").length > 6;
    return (
      <div className="my-3 ml-9 overflow-hidden rounded-surface border border-accent/25 bg-tmsg shadow-1">
        <div className="flex items-center gap-2 px-3.5 pt-2">
          <span className="flex h-6.5 w-6.5 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
            <Mail className="h-3.5 w-3.5" aria-hidden />
          </span>
          <span className="text-[11px] font-semibold text-dim">{item.dir === "out" ? tr("render.toDir") : tr("render.fromDir")}</span>
          <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-bold text-accent">{item.peer}</span>
          {item.delivery ? (
            <span
              className={`inline-flex shrink-0 items-center gap-1 text-[10.5px] font-semibold ${item.delivery === "ok" ? "text-ok" : "text-err"}`}
              title={item.msgId ? `msg_id: ${item.msgId}` : undefined}
            >
              {item.delivery === "ok" ? <Check className="h-3 w-3" aria-hidden /> : <X className="h-3 w-3" aria-hidden />}
              {item.delivery === "ok" ? tr("render.delivered") : tr("render.notDelivered")}
            </span>
          ) : null}
          {hhmm(item.ts) ? <span className="ml-auto shrink-0 text-label tabular-nums text-dim">{hhmm(item.ts)}</span> : null}
        </div>
        <div className="px-3.5 pb-2.5 pt-1">
          {protocol ? (
            <ProtocolMessageBody payload={protocol} />
          ) : (
            <>
              {item.summary ? <div className="text-[13px] font-bold">{md(item.summary)}</div> : null}
              {long ? (
                <details className="group/tmsg mt-0.5 whitespace-pre-wrap break-words text-[13px]">
                  <summary className="cursor-pointer list-none text-[12.5px] text-faint [&::-webkit-details-marker]:hidden">
                    <span className="group-open/tmsg:hidden">
                      {item.text.slice(0, 260).trimEnd()}… <span className="font-semibold text-accent">{tr("common.showAll")}</span>
                    </span>
                    <span className="hidden items-center gap-1 text-[11px] font-semibold text-dim group-open/tmsg:inline-flex">
                      {tr("common.collapse")} <ChevronUp className="h-3 w-3" aria-hidden />
                    </span>
                  </summary>
                  {mdBlocks(item.text)}
                </details>
              ) : (
                <div className="mt-0.5 whitespace-pre-wrap break-words text-[13px]">{mdBlocks(item.text)}</div>
              )}
            </>
          )}
        </div>
      </div>
    );
  }
  if (item.kind === "tnote") {
    return (
      <div className="my-0.5 ml-9 flex items-center gap-1.5 text-label text-muted">
        <Mail className="h-3 w-3 shrink-0" aria-hidden />
        {item.text}
      </div>
    );
  }
  if (item.kind === "think") {
    const long = item.text.length > 150;
    return (
      <details className="my-0.5 ml-9 text-label italic text-muted">
        <summary className={`flex list-none items-center gap-1.5 truncate ${long ? "cursor-pointer [@media(pointer:coarse)]:min-h-11" : ""}`} title={tr("render.reasoning")}>
          <Brain className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="truncate">
            {item.text.slice(0, 150)}
            {long ? "…" : ""}
          </span>
        </summary>
        {long ? <div className="whitespace-pre-wrap break-words pt-1 not-italic">{mdBlocks(item.text)}</div> : null}
      </details>
    );
  }
  if (item.kind === "svc") return <div className="my-1 break-words text-[11.5px] text-dim">{item.text}</div>;
  if (item.kind === "note") return <div className="my-2 break-words text-[12.5px] text-dim">{md(item.text)}</div>;
  return <div className={`my-0.5 break-words text-[12.5px] ${item.err ? "text-err" : "text-faint"}`}>{item.text}</div>;
});
