"use client";

import { useState, type ReactNode } from "react";

import { ChevronRight, GlyphIcon, RotateCw } from "../../icons";
import { hhmm } from "../../utils";
import { MESSAGE_ACTION } from "../actionStyles";
import { CopyButton } from "../CopyButton";
import { mandateMessage } from "../mandateMessage";
import { mdBlocks } from "../markdown";
import { tr, type MandateItem } from "../parse";

/**
 * The orchestrator seat's mandate, as the feed's own card (#1166).
 *
 * The operator never typed these 8 KB — the seat delivered them — so the row
 * says what it is (which mandate, how long, when it arrived) and keeps the text
 * folded away. A rotation handoff is a SECOND section of the same card, because
 * it is a second thing the seat said at creation, not a second message.
 *
 * Both sections mount their body only once opened: the point of the card is
 * that a conversation no longer pays 8 KB of markdown to show its first row.
 *
 * `version` is what the seat itself recorded, carried here by the delivery
 * evidence, so the dock and the board's conversation pane name the same mandate
 * the same way — including the bespoke one, which reads `custom` on both.
 */
export function MandateCard({ item }: { item: MandateItem }) {
  const message = mandateMessage(item.text);
  const qualifier = item.version === null
    ? tr("mandateCard.custom")
    : tr("mandateCard.version", { version: item.version });
  return (
    <div className="my-3 ml-9 overflow-hidden rounded-surface border border-border bg-card shadow-1" data-mandate-card>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-3.5 pt-2">
        <span className="flex h-6.5 w-6.5 shrink-0 items-center justify-center rounded-lg bg-sunken text-muted">
          <GlyphIcon name="plan" className="h-3.5 w-3.5" />
        </span>
        <span className="text-[13px] font-semibold">{`${tr("mandateCard.title")} ${qualifier}`}</span>
        <span className="text-[11px] text-muted">
          · {tr("mandateCard.lines", { count: message.lines })} · {tr("mandateCard.sent")}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <CopyButton text={item.text} label={tr("feed.copyMd")} className={MESSAGE_ACTION} />
          {hhmm(item.ts) ? <span className="text-label tabular-nums text-muted">{hhmm(item.ts)}</span> : null}
        </span>
      </div>
      <div className="px-3.5 pb-2.5 pt-1">
        <Section label={tr("mandateCard.readMandate")} text={message.mandate} />
        {message.handoff ? (
          <Section
            label={tr("mandateCard.handoff")}
            text={message.handoff}
            icon={<RotateCw className="h-3 w-3 shrink-0 text-muted" aria-hidden />}
            className="mt-1.5 border-t border-border pt-1.5"
          />
        ) : null}
      </div>
    </div>
  );
}

function Section({
  label,
  text,
  icon,
  className = "",
}: {
  label: string;
  text: string;
  icon?: ReactNode;
  className?: string;
}) {
  const [mounted, setMounted] = useState(false);
  return (
    <details
      className={`group/section text-[13px] ${className}`}
      onToggle={(event) => {
        if (event.currentTarget.open) setMounted(true);
      }}
    >
      <summary className="flex cursor-pointer list-none items-center gap-1 rounded-control py-0.5 text-[12.5px] font-semibold text-secondary hover:text-accent [@media(pointer:coarse)]:min-h-11 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-3 w-3 shrink-0 transition-transform group-open/section:rotate-90" aria-hidden />
        {icon}
        <span>{label}</span>
      </summary>
      {mounted ? (
        <div className="mt-1 whitespace-pre-wrap break-words border-t border-border pt-1.5">{mdBlocks(text)}</div>
      ) : null}
    </details>
  );
}
