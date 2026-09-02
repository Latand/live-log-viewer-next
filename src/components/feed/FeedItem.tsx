"use client";

import { memo } from "react";

import { useIsMobile } from "@/hooks/useIsMobile";
import type { MandateDelivery } from "@/lib/runtime/messageOrigin";

import { Brain, ChevronUp, Command, Check, Mail, MessageCircle, Mic, Sparkle, X } from "../icons";
import { hhmm } from "../utils";
import { MESSAGE_ACTION } from "./actionStyles";
import { SelectedContextBadge } from "../SelectedContextBadge";
import { CopyButton } from "./CopyButton";
import { InboxImageCard } from "./InboxImage";
import { md, mdBlocks } from "./markdown";
import { useMessageProvenance, type ProvenanceLookup } from "./messageProvenance";
import { tr, type Item } from "./parse";
import { BlobCard } from "./cards/BlobCard";
import { CmdGroupCard } from "./cards/CmdGroupCard";
import { CompactBand } from "./cards/CompactBand";
import { ImageCard } from "./cards/ImageCard";
import { MandateCard } from "./cards/MandateCard";
import { MemCitationCard } from "./cards/MemCitationCard";
import { ProtocolMessageBody, parseProtocolPayload } from "./cards/ProtocolMessage";
import { ReviewCard } from "./cards/ReviewCard";
import { RecordCard } from "./cards/RecordCard";
import { SysMsgCard } from "./cards/SysMsgCard";
import { ToolCard } from "./cards/ToolCard";
import { WakeupCard } from "./cards/WakeupCard";
import { SpeakButton } from "./SpeakButton";
import { McpCallCard } from "../runtime/McpCallCard";

/**
 * Resolves a row with delivery evidence (#1117). A delivered Claude system row
 * joins the ledger by engine message id — operator evidence becomes the
 * operator's own bubble, agent evidence the internal card naming the sender
 * role — and otherwise the occurrence join (pre-#1117 structured relays). A
 * plain user bubble (a legacy tmux paste on either engine) becomes the
 * internal card only when a settled agent delivery is joined to THIS row —
 * same text, nearest its settlement time — so an operator's own message that
 * repeats a relay's words stays the operator's. No evidence — no provider,
 * unknown id, scaffold row, the operator's own words — keeps the row untouched.
 *
 * One more class of evidence rides here (#1166): the SAME occurrence record can
 * say that its delivery was an orchestrator seat's mandate, and then the row is
 * the seat's own card. Because the fact belongs to the delivery rather than to
 * the text, an agent relay that repeats the mandate's bytes carries no such
 * record and stays the relay it is, and an operator who pastes them by hand
 * keeps their own bubble.
 */
function resolveDeliveredItem(item: Item, provenance: ProvenanceLookup): Item {
  if (item.kind === "user") {
    /* A selected-context capture exists only on operator composer sends. */
    if (item.selectedContext) return item;
    const resolved = provenance.forItem(item);
    if (resolved?.mandate) return mandateCard(item.ts, item.text, resolved.mandate);
    if (resolved?.origin === "agent") return internalCard(item.ts, item.text, resolved.senderRole);
    return item;
  }
  if (item.kind !== "sysmsg" || !item.deliveredMessage) return item;
  const resolved = provenance.forItem(item);
  if (resolved?.mandate) return mandateCard(item.deliveredMessage.ts, item.text, resolved.mandate);
  if (resolved?.origin === "agent") return internalCard(item.deliveredMessage.ts, item.text, resolved.senderRole);
  if (resolved?.origin === "operator") {
    return {
      kind: "user",
      ts: item.deliveredMessage.ts,
      text: item.text,
      ...(resolved.selectedContext ? { selectedContext: resolved.selectedContext } : {}),
    };
  }
  return item;
}

function mandateCard(ts: unknown, text: string, mandate: MandateDelivery): Item {
  return { kind: "mandate", ts, text, mandate };
}

function internalCard(ts: unknown, text: string, senderRole: string | undefined): Item {
  return {
    kind: "tmsg",
    ts,
    dir: "in",
    peer: senderRole ?? tr("render.agentPeer"),
    summary: "",
    text,
    internal: true,
  };
}

/* Mobile v2 (#1439, lane 4): the engine mark is the only avatar left on the
   phone — a 16 px glyph in secondary colour beside the engine's name in the
   message header (README §5). Proper nouns, so no locale entry. */
const ENGINE_LABEL: Record<"codex" | "claude" | "openclaw", string> = {
  claude: "Claude",
  codex: "Codex",
  openclaw: "OpenClaw",
};

/* Memoized: feed items are immutable after buildFeed, so a pane re-render
   (poll tick, camera state, files refresh) skips re-parsing markdown for
   every message that did not change. The provenance lookup arrives by context,
   so a resolved map re-renders exactly the memoized consumers. */
export const FeedItem = memo(function FeedItem({ item: sourceItem, speakText }: { item: Item; speakText?: string }) {
  const provenance = useMessageProvenance();
  const isMobile = useIsMobile();
  const item = resolveDeliveredItem(sourceItem, provenance);
  /* Mobile v2 (#1439, lane 4): no avatar column on the phone, so nothing lines
     up with one — the `ml-9` chrome indent goes with it. */
  const indent = isMobile ? "" : "ml-9 ";
  if (item.kind === "image") return <ImageCard media={item.media} data={item.data} w={item.w} h={item.h} bytes={item.bytes} />;
  if (item.kind === "inbox-image") return <InboxImageCard name={item.name} path={item.path} />;
  if (item.kind === "blob") return <BlobCard bytes={item.bytes} text={item.text} />;
  if (item.kind === "sysmsg") return <SysMsgCard label={item.label} text={item.text} />;
  if (item.kind === "mandate") return <MandateCard item={item} />;
  if (item.kind === "compact") return <CompactBand item={item} />;
  if (item.kind === "review") return <ReviewCard item={item} />;
  if (item.kind === "record") return <RecordCard item={item} />;
  if (item.kind === "mem-citation") return <MemCitationCard item={item} />;
  if (item.kind === "prose") {
    const cls = item.engine === "codex" ? "bg-codex" : item.engine === "openclaw" ? "bg-openclaw" : "bg-claude";
    const AvatarIcon = item.engine === "codex" ? Command : item.engine === "openclaw" ? MessageCircle : Sparkle;
    if (isMobile) {
      /* Mobile v2 (#1439, lane 4; README §2.6, §4.2): content gets the width.
         No avatar column; the header is one 44 px row — engine glyph, engine
         name, time, then the read-aloud and copy targets — and the prose
         starts under it at 15 px. The wrapper carries no vertical margin and
         nothing negative: the header's own height is the gap above the
         message, so it can never overlap the text. */
      const time = hhmm(item.ts);
      return (
        <div className="group/msg" data-mobile-message="agent">
          <div data-mobile-message-header className="flex h-11 w-full items-center gap-1.5 text-label text-muted">
            <AvatarIcon className="h-4 w-4 shrink-0 text-secondary" aria-hidden />
            <span className="font-semibold text-secondary">{ENGINE_LABEL[item.engine]}</span>
            <span className="ml-auto flex shrink-0 items-center gap-1">
              {time ? <span className="tabular-nums">{time}</span> : null}
              {speakText ? <SpeakButton text={speakText} /> : null}
              <CopyButton text={item.text} label={tr("feed.copyMd")} className={MESSAGE_ACTION} />
            </span>
          </div>
          <div className="w-full whitespace-pre-wrap break-words text-title leading-[1.45]" data-tts-message={`${item.engine}:${item.ts}`}>
            <div className="contents" data-tts-body>{mdBlocks(item.text)}</div>
          </div>
        </div>
      );
    }
    return (
      <div className="group/msg my-3 flex gap-2.5">
        <div className={`mt-1 flex h-6.5 w-6.5 shrink-0 items-center justify-center rounded-full text-white ${cls}`}>
          <AvatarIcon className="h-3.5 w-3.5" aria-hidden />
        </div>
        {/* `data-tts-message` / `data-tts-body`: the anchors the read-aloud
            control uses to find the RENDERED text of this answer, so the
            karaoke highlight and click-to-seek of #1022 ride over the markdown
            already on screen instead of re-parsing it. The value is the answer's
            identity — the engine/timestamp pair `speakableAnswer` groups on —
            so a control on the first block of a multi-block answer can claim
            the rest of it and stop at the next answer. The body wrapper is
            `display: contents`, so it changes no layout. */}
        <div className="min-w-0 flex-1 whitespace-pre-wrap break-words" data-tts-message={`${item.engine}:${item.ts}`}>
          {/* Issue #698: this cluster used to be `absolute right-0 top-0` over a
              body with no reserved gutter — on a coarse pointer the 44px buttons
              sat permanently at 60% opacity on the first lines of the message,
              and on desktop the same controls were invisible until hover. They
              now hold their own row above the text: they cover nothing at any
              width, and they are visible without a hover. */}
          <div className="mb-0.5 flex min-h-6 items-center gap-1">
            {hhmm(item.ts) ? <span className="text-label tabular-nums text-muted">{hhmm(item.ts)}</span> : null}
            <span className="ml-auto flex shrink-0 items-center gap-0.5">
              {speakText ? <SpeakButton text={speakText} /> : null}
              <CopyButton text={item.text} label={tr("feed.copyMd")} className={MESSAGE_ACTION} />
            </span>
          </div>
          <div className="contents" data-tts-body>{mdBlocks(item.text)}</div>
        </div>
      </div>
    );
  }
  /* A voice turn is the operator speaking, so it keeps the user side of the
     feed — but labelled and with the call's interleaved transcript folded away,
     because that tail repeats itself turn over turn and is only ever read when
     something sounded wrong. */
  if (item.kind === "voice") {
    return (
      <div className="group/msg my-3 flex items-start justify-end gap-1.5">
        <CopyButton
          text={item.input || item.delta}
          label={tr("feed.copyMd")}
          className={`mt-2 ${MESSAGE_ACTION}`}
        />
        <div className={isMobile ? "max-w-[86%] rounded-surface bg-user px-3 py-[9px] text-title leading-[1.45]" : "max-w-[75%] rounded-surface bg-user px-4 py-2.5"}>
          <span className="mb-1 flex items-center gap-1 text-caption uppercase tracking-wide text-muted">
            <Mic className="h-3 w-3" aria-hidden />
            {tr("feed.voiceTurn")}
          </span>
          {item.input ? (
            <p className="whitespace-pre-wrap break-words">{item.input}</p>
          ) : null}
          {item.delta ? (
            <details className="mt-1.5">
              <summary className="cursor-pointer list-none text-caption text-muted [&::-webkit-details-marker]:hidden">
                {tr("feed.voiceContext")}
              </summary>
              <pre className="mt-1 whitespace-pre-wrap break-words text-label text-secondary">{item.delta}</pre>
            </details>
          ) : null}
        </div>
      </div>
    );
  }
  if (item.kind === "user") {
    const long = item.text.length > 500;
    return (
      <div className="group/msg my-3 flex items-start justify-end gap-1.5" data-mobile-message={isMobile ? "user" : undefined}>
        <CopyButton
          text={item.text}
          label={tr("feed.copyMd")}
          className={`mt-2 ${MESSAGE_ACTION}`}
        />
        {/* Mobile v2 (#1439, lane 4): the user keeps the bubble, at 86% and
            15 px on the phone (README §2.6). */}
        <div className={isMobile ? "max-w-[86%] whitespace-pre-wrap break-words rounded-surface bg-user px-3 py-[9px] text-title leading-[1.45]" : "max-w-[75%] whitespace-pre-wrap break-words rounded-surface bg-user px-4 py-2.5"}>
          {/* #844: what this turn pointed at, from the reference persisted on
              the record itself — the same badge the composer showed before the
              operator sent it, so the two can be compared at a glance. */}
          {item.selectedContext ? (
            <SelectedContextBadge reference={item.selectedContext} className="mb-1.5" />
          ) : null}
          {long ? (
            <details className="group/usr">
              <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
                <span className="group-open/usr:hidden">
                  {item.text.slice(0, 180)}… <span className="font-semibold text-accent">({tr("common.chars", { n: item.text.length })})</span>
                </span>
                <span className="hidden items-center gap-1 text-[11px] font-semibold text-muted group-open/usr:inline-flex">
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
  if (item.kind === "tool" && item.mcp) return <McpCallCard event={item} />;
  if (item.kind === "tool" && item.wakeup) return <WakeupCard event={item} wakeup={item.wakeup} />;
  if (item.kind === "tool") return <ToolCard event={item} />;
  if (item.kind === "cmd-group") return <CmdGroupCard item={item} />;
  if (item.kind === "tmsg") {
    const protocol = parseProtocolPayload(item.text);
    const long = item.text.length > 420 || item.text.split("\n").length > 6;
    return (
      <div className={`my-3 ${indent}overflow-hidden rounded-surface border border-accent/25 bg-accent-soft shadow-1`}>
        <div className="flex items-center gap-2 px-3.5 pt-2">
          <span className="flex h-6.5 w-6.5 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
            <Mail className="h-3.5 w-3.5" aria-hidden />
          </span>
          {/* #1117: an MCP/structured relay says outright that it is internal
              traffic, and the peer pill names the sender ROLE, so the operator
              never mistakes it for their own words or for scaffold. */}
          {item.internal ? (
            <span className="rounded-full border border-accent/40 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-accent">
              {tr("render.internalTag")}
            </span>
          ) : null}
          <span className="text-[11px] font-semibold text-muted">{item.dir === "out" ? tr("render.toDir") : tr("render.fromDir")}</span>
          <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-bold text-accent">{item.peer}</span>
          {item.delivery ? (
            <span
              className={`inline-flex shrink-0 items-center gap-1 text-[10.5px] font-semibold ${item.delivery === "ok" ? "text-success" : "text-danger"}`}
              title={item.msgId ? `msg_id: ${item.msgId}` : undefined}
            >
              {item.delivery === "ok" ? <Check className="h-3 w-3" aria-hidden /> : <X className="h-3 w-3" aria-hidden />}
              {item.delivery === "ok" ? tr("render.delivered") : tr("render.notDelivered")}
            </span>
          ) : null}
          {hhmm(item.ts) ? <span className="ml-auto shrink-0 text-label tabular-nums text-muted">{hhmm(item.ts)}</span> : null}
        </div>
        <div className="px-3.5 pb-2.5 pt-1">
          {protocol ? (
            <ProtocolMessageBody payload={protocol} />
          ) : (
            <>
              {item.summary ? <div className="text-[13px] font-bold">{md(item.summary)}</div> : null}
              {long ? (
                <details className="group/tmsg mt-0.5 whitespace-pre-wrap break-words text-[13px]">
                  <summary className="cursor-pointer list-none text-[12.5px] text-secondary [&::-webkit-details-marker]:hidden">
                    <span className="group-open/tmsg:hidden">
                      {item.text.slice(0, 260).trimEnd()}… <span className="font-semibold text-accent">{tr("common.showAll")}</span>
                    </span>
                    <span className="hidden items-center gap-1 text-[11px] font-semibold text-muted group-open/tmsg:inline-flex">
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
      <div className={`my-0.5 ${indent}flex items-center gap-1.5 text-label text-muted`}>
        <Mail className="h-3 w-3 shrink-0" aria-hidden />
        {item.text}
      </div>
    );
  }
  if (item.kind === "think") {
    const long = item.text.length > 150;
    return (
      <details className={`my-0.5 ${indent}text-label italic text-muted`}>
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
  if (item.kind === "svc") return <div className="my-1 break-words text-[11.5px] text-muted">{item.text}</div>;
  if (item.kind === "note") return <div className="my-2 break-words text-[12.5px] text-muted">{md(item.text)}</div>;
  return <div className={`my-0.5 break-words text-[12.5px] ${item.err ? "text-danger" : "text-secondary"}`}>{item.text}</div>;
});
