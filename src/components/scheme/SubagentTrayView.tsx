"use client";

import { useRef } from "react";

import { useLocale } from "@/lib/i18n";

import type { ParentTray, SubagentBadgeState, TrayMember } from "./subagentTray";

/** The single tray surface the board threads from the S2 projection down to
    each node — its trays keyed by durable parent id, the folded child paths to
    exclude from the promoted badge rail, and the durable-intent callbacks. */
export interface SubagentTrayApi {
  trays: ReadonlyMap<string, ParentTray>;
  /** Folded child transcript paths — excluded from the promoted badge rail so a
      card renders in exactly one surface. */
  foldedChildPaths: ReadonlySet<string>;
  onToggleExpanded: (parentId: string, expanded: boolean) => void;
  onOpenMember: (path: string) => void;
  onUnfold: (id: string, path: string) => void;
  /** Hand-fold a promoted (live) child into the tray — a durable fold pin. */
  onFoldChild: (id: string, path: string) => void;
}

export interface SubagentTrayProps {
  tray: ParentTray;
  /** Persist the durable tray-disclosure intent for the parent. */
  onToggleExpanded: (expanded: boolean) => void;
  /** Open a folded member's transcript read-only (an ephemeral P4 overlay). */
  onOpenMember: (path: string) => void;
  /** Restore a folded member to a full card (clears its durable fold pin). */
  onUnfold: (id: string, path: string) => void;
  /** `docked` (default) sits on a desktop card's lower edge; `inline` renders a
      static block with 44px touch targets inside the mobile focused parent. */
  variant?: "docked" | "inline";
}

/** Up to this many roll-up dots render on the collapsed chip before the count
    alone carries the rest — keeps the chip inside the card's lower edge. */
const MAX_DOTS = 6;

function dotClass(state: SubagentBadgeState): string {
  if (state === "running" || state === "live") return "bg-success";
  if (state === "closed") return "bg-muted";
  return "bg-danger";
}

/**
 * The engine-native subagent tray (issue #142 §1.4): a slim row docked on the
 * parent card's lower edge — `⑂ N` plus roll-up state dots. Enter/click expands
 * it in place into compact member rows (the existing quiet-branch mini-stack
 * grammar) behind a durable disclosure pin. Each row opens the child transcript
 * read-only; nothing here mutates board membership except an explicit unfold.
 */
export function SubagentTray({ tray, onToggleExpanded, onOpenMember, onUnfold, variant = "docked" }: SubagentTrayProps) {
  const { t } = useLocale();
  const chipRef = useRef<HTMLButtonElement>(null);
  if (tray.count === 0) return null;
  const inline = variant === "inline";

  const rowsId = `subagent-tray-${tray.parentConversationId}`;
  const stateLabel = (state: SubagentBadgeState) => t(`subagentTray.state.${state}` as "subagentTray.state.running");
  const closeToChip = () => {
    onToggleExpanded(false);
    /* Restore focus to the disclosure control after collapsing (a11y): the
       rows the user was inside are gone, so focus must land somewhere stable. */
    requestAnimationFrame(() => chipRef.current?.focus());
  };

  return (
    <div
      data-subagent-tray={tray.parentConversationId}
      data-subagent-tray-variant={variant}
      data-scheme-ui
      className={inline
        ? "pointer-events-auto flex w-full min-w-0 flex-col items-stretch"
        : "pointer-events-auto absolute inset-x-2 -bottom-3 z-[7] flex flex-col items-stretch"}
    >
      <button
        ref={chipRef}
        type="button"
        data-subagent-tray-toggle
        aria-expanded={tray.expanded}
        aria-controls={rowsId}
        aria-label={t(tray.expanded ? "subagentTray.collapse" : "subagentTray.toggle", { count: tray.count })}
        className={inline
          ? "inline-flex min-h-11 w-full items-center justify-between gap-1.5 rounded-[10px] border border-border bg-card px-3 text-[12px] font-semibold text-muted shadow-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/55"
          : "inline-flex h-6 items-center gap-1.5 self-center rounded-full border border-border bg-card px-2.5 text-[11px] font-semibold text-muted shadow-1 hover:border-accent/40 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/55"}
        onClick={() => onToggleExpanded(!tray.expanded)}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <span aria-hidden className="text-[12px] leading-none">⑂</span>
          <span className="tabular-nums truncate">{t("subagentTray.label", { count: tray.count })}</span>
        </span>
        <span aria-hidden className="flex items-center gap-0.5">
          {tray.members.slice(0, MAX_DOTS).map((member) => (
            <span key={member.id} className={`inline-block h-1.5 w-1.5 rounded-full ${dotClass(member.state)}`} />
          ))}
        </span>
      </button>
      {tray.expanded ? (
        <ul
          id={rowsId}
          aria-label={t("subagentTray.rows")}
          className="mt-1 flex w-full min-w-0 flex-col gap-0.5 rounded-[10px] border border-dashed border-border bg-card/95 p-1 shadow-1"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              closeToChip();
            }
          }}
        >
          {tray.members.map((member: TrayMember) => (
            <li key={member.id} className="flex min-w-0 items-center gap-1">
              <button
                type="button"
                data-subagent-tray-member={member.id}
                data-subagent-state={member.state}
                aria-label={t("subagentTray.open", { name: member.title })}
                title={`${member.title} · ${stateLabel(member.state)}`}
                className={`flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 text-left font-medium text-primary hover:bg-accent/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/55 ${inline ? "min-h-11 text-[13px]" : "py-1 text-[11px]"}`}
                onClick={() => onOpenMember(member.path)}
              >
                <span aria-hidden className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${dotClass(member.state)}`} />
                <span className="min-w-0 truncate">{member.title}</span>
              </button>
              <button
                type="button"
                data-subagent-tray-unfold={member.id}
                aria-label={t("subagentTray.unfold", { name: member.title })}
                className={`shrink-0 rounded-md text-muted hover:bg-accent/10 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/55 ${inline ? "inline-flex min-h-11 min-w-11 items-center justify-center text-[13px]" : "px-1 py-1 text-[11px]"}`}
                onClick={() => onUnfold(member.id, member.path)}
              >
                <span aria-hidden>↥</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
