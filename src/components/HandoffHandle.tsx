"use client";

import { ArrowDown, ArrowRightLeft } from "lucide-react";

import { useLocale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

import { useAgentLink } from "./AgentLink";

/** Handoff targets an on-disk transcript another agent can read back. */
export function canHandoff(file: FileEntry): boolean {
  return (file.root === "claude-projects" || file.root === "codex-sessions") && file.path.endsWith(".jsonl");
}

interface Props {
  file: FileEntry;
  /** Opens (or refocuses) the handoff draft pane under this conversation. */
  onHandoff: () => void;
  /** Phone variant (finding 1): render as an in-flow 44px button below the pane
      instead of the scheme's floating `-bottom-11` handle, so it reserves its
      own space and never straddles the docked footer below the focus view. */
  docked?: boolean;
}

/**
 * The handoff handle pinned outside the pane, at its bottom-left — right where
 * child arrows leave the card. It sits still (no cursor chasing), grows on
 * hover into a labeled chip with a down arrow pointing at where the draft
 * conversation will land, and a click drops that draft below: a full
 * DraftAgentPane that inherits this conversation's transcript and directory.
 * Pulling the handle instead of clicking still links to an existing pane.
 */
export function HandoffHandle({ file, onHandoff, docked = false }: Props) {
  const { t } = useLocale();
  const link = useAgentLink(file);
  if (docked) {
    return (
      <div data-scheme-ui className="shrink-0 px-1.5 pt-1.5">
        <button
          type="button"
          aria-label={t("handoff.aria")}
          title={t("handoff.title")}
          onPointerDown={link.onPillPointerDown}
          onClick={() => {
            if (link.consumeClick()) return;
            onHandoff();
          }}
          className="flex min-h-11 w-full touch-none items-center justify-center gap-1.5 rounded-[8px] border border-line bg-panel text-[12px] font-semibold text-dim shadow-card hover:border-accent/50 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <ArrowRightLeft className="h-4 w-4 shrink-0" aria-hidden />
          {t("handoff.label")}
        </button>
        {link.overlay}
      </div>
    );
  }
  return (
    <div data-scheme-ui className="group absolute -bottom-11 left-2 z-[2]">
      <button
        type="button"
        aria-label={t("handoff.aria")}
        title={t("handoff.title")}
        onPointerDown={link.onPillPointerDown}
        onClick={() => {
          if (link.consumeClick()) return;
          onHandoff();
        }}
        className="flex h-7 touch-none items-center gap-1.5 rounded-full border border-line bg-panel px-2 text-dim shadow-card transition-[border-color,color] duration-150 hover:border-accent/50 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        <ArrowRightLeft className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="max-w-[0px] overflow-hidden whitespace-nowrap text-[11px] font-semibold transition-[max-width] duration-200 group-hover:max-w-[180px] group-focus-within:max-w-[180px]">
          {t("handoff.label")}
        </span>
        <ArrowDown className="hidden h-3.5 w-3.5 shrink-0 group-hover:block group-focus-within:block" aria-hidden />
      </button>
      {link.overlay}
    </div>
  );
}
