"use client";

import { Check, ChevronRight } from "lucide-react";

import { useLocale, type MessageKey, type TFunction } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

import { conversationIdentity } from "@/lib/accounts/identity";
import { cleanTitle, engineBadge } from "../utils";
import { MobileSheet, MobileSheetSection } from "./MobileSheet";
import { CHAT_TONE_DOT, CHAT_TONE_TEXT, chatState, chatStateBits, type ChatStateKey } from "./mobileChatState";

/*
 * The conversation switcher (docs/design/mobile-v2/README.md §3.1, §4.2): the
 * bar's title cell opens it, and it mirrors the board's sections — the
 * orchestrator, Needs you, Working, Recent — as dense 44 px rows with the
 * current one checked and «Board ›» in the header.
 *
 * A row REPLACES the conversation on top of the stack (a sibling switch), so
 * ‹ still leaves the way the operator came in. The bar and dock swipe walk the
 * same list without opening it, and deliberately skip Recent and the drafts:
 * stepping through finished work — or through a form nobody has sent yet — one
 * swipe at a time is not what the gesture is for (`SWITCH_SWIPE_SECTIONS`).
 *
 * Everything the retired chip strip could reach is listed here, so the strip's
 * removal costs no destination: conversations, the review-round decks that
 * stand in for a folded reviewer transcript, and the not-yet-spawned drafts.
 */

export type SwitchSection = "orchestrator" | "needs" | "working" | "recent" | "drafts";

/** Every section, in the order the sheet renders them. */
export const SWITCH_SECTIONS: readonly SwitchSection[] = ["orchestrator", "needs", "working", "recent", "drafts"];

/** The sections the bar/dock swipe walks, in order. Recent is not among them. */
export const SWITCH_SWIPE_SECTIONS: readonly SwitchSection[] = ["orchestrator", "needs", "working"];

const SECTION_OF: Record<ChatStateKey, SwitchSection> = {
  offline: "working",
  killed: "recent",
  stalled: "needs",
  limit: "needs",
  held: "working",
  waiting: "needs",
  working: "working",
  returned: "recent",
  done: "recent",
};

/** One thing the phone can put on screen: a conversation, a review-round deck
    (named for the work it reviews, stated by its newest round), or a draft. */
export interface SwitchCandidate {
  /** The board key the conversation screen pins. */
  key: string;
  /** The conversation whose state and identity the row shows; null for a
      draft, which has no transcript and therefore no state. */
  file: FileEntry | null;
  /** Row title; a deck and a draft name themselves, a conversation does not. */
  label?: string;
  /** The meta line for a row with no file behind it. */
  meta?: string;
  /** Forces the section: a draft belongs to none of the state ones. */
  section?: SwitchSection;
}

export interface SwitchEntry {
  /** The switcher's identity for a conversation, and the chat screen's own
      `data-mobile2-conversation` — the two must agree for the swipe to walk. */
  id: string;
  /** The board key the focus view pins (the transcript path, the deck key). */
  key: string;
  file: FileEntry | null;
  label: string;
  meta: string | null;
  section: SwitchSection;
}

export interface SwitchListOptions {
  /** The project's orchestrator seat conversation, pinned first (#976). */
  seatKey?: string | null;
  nowMs?: number;
}

/**
 * The switcher's list, in the order it renders and the order the swipe walks:
 * the seat first, then Needs you, Working, Recent and the drafts, each in the
 * board order it was given. The state that decides the section is the ONE state
 * (`mobileChatState`), so a conversation can never sit in two sections or be
 * called working in one place and blocked in another.
 */
export function switchList(candidates: readonly SwitchCandidate[], { seatKey = null, nowMs = Date.now() }: SwitchListOptions = {}): SwitchEntry[] {
  const entries: SwitchEntry[] = candidates.map((candidate) => ({
    id: candidate.file ? conversationIdentity(candidate.file) : candidate.key,
    key: candidate.key,
    file: candidate.file,
    label: candidate.label ?? (candidate.file ? cleanTitle(candidate.file.title, 90) : candidate.key),
    meta: candidate.meta ?? null,
    section: candidate.section
      ?? (candidate.key === seatKey ? "orchestrator" : candidate.file ? SECTION_OF[chatState(candidate.file, { nowMs })] : "drafts"),
  }));
  return SWITCH_SECTIONS.flatMap((section) => entries.filter((entry) => entry.section === section));
}

/** The list the bar and dock swipe steps through: the switcher's order minus
    Recent and the drafts (§3.3). */
export function swipeOrder(entries: readonly SwitchEntry[]): SwitchEntry[] {
  return entries.filter((entry) => SWITCH_SWIPE_SECTIONS.includes(entry.section));
}

/** The sibling one swipe away, or null at either end (the bar bumps instead). */
export function swipeTarget(entries: readonly SwitchEntry[], currentKey: string | null, direction: 1 | -1): SwitchEntry | null {
  const list = swipeOrder(entries);
  const index = list.findIndex((entry) => entry.key === currentKey);
  if (index < 0) return null;
  return list[index + direction] ?? null;
}

const SECTION_LABEL: Record<SwitchSection, MessageKey> = {
  orchestrator: "mobile2.chat.sectionOrchestrator",
  needs: "mobile2.chat.sectionNeedsYou",
  working: "mobile2.chat.sectionWorking",
  recent: "mobile2.chat.sectionRecent",
  drafts: "mobile2.chat.sectionDrafts",
};

function SwitchRow({ t, entry, current, nowMs, onPick }: { t: TFunction; entry: SwitchEntry; current: boolean; nowMs: number; onPick: () => void }) {
  const bits = entry.file ? chatStateBits(t, entry.file, { nowMs }) : null;
  const badge = entry.file ? engineBadge(entry.file) : null;
  return (
    <button
      type="button"
      data-mobile2-go="chat"
      data-mobile2-section={entry.section}
      data-mobile2-conversation={entry.id}
      aria-current={current ? "true" : undefined}
      onClick={onPick}
      className="flex min-h-11 w-full items-center gap-2.5 px-4 py-1 text-left active:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
    >
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${bits ? CHAT_TONE_DOT[bits.tone] : "bg-strong"}`} aria-hidden />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={`min-w-0 truncate text-body font-semibold ${current ? "text-accent" : "text-primary"}`}>{entry.label}</span>
        <span className="flex min-w-0 items-center gap-1 text-label font-medium text-secondary">
          {bits ? (
            <>
              <span className={`shrink-0 ${CHAT_TONE_TEXT[bits.tone]}`}>{bits.phrase}</span>
              <span aria-hidden className="text-muted">·</span>
              <span className="min-w-0 truncate">{entry.file?.model ?? badge?.label}</span>
            </>
          ) : (
            <span className="min-w-0 truncate">{entry.meta}</span>
          )}
        </span>
      </span>
      {current ? <Check className="h-4 w-4 shrink-0 text-accent" aria-hidden /> : null}
    </button>
  );
}

export function MobileSwitchSheet({
  title,
  entries,
  currentKey,
  nowMs = Date.now(),
  onPick,
  onBoard,
  onProjects,
  onClose,
}: {
  /** The sheet's title: the project, exactly as the prototype shows it. */
  title: string;
  entries: readonly SwitchEntry[];
  currentKey: string | null;
  nowMs?: number;
  onPick: (entry: SwitchEntry) => void;
  /** «Board ›» in the header; absent when there is no board to go back to. */
  onBoard?: () => void;
  /** Interim, while the conversation is the phone's own leaf and there is no
      board screen to pop to (lane 2): the header cell opens the project
      switcher instead, so switching projects stays one tap from here. */
  onProjects?: () => void;
  onClose: () => void;
}) {
  const { t } = useLocale();
  const extra = onBoard ? (
    <button
      type="button"
      data-mobile2-go="board"
      onClick={onBoard}
      className="inline-flex min-h-11 shrink-0 items-center gap-0.5 rounded-[8px] px-2.5 text-ui font-bold text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
    >
      {t("mobile2.chat.board")}
      <ChevronRight className="h-4 w-4" aria-hidden />
    </button>
  ) : onProjects ? (
    <button
      type="button"
      data-mobile2-open="projects"
      aria-label={t("mobile2.bar.switchProject")}
      onClick={onProjects}
      className="inline-flex min-h-11 shrink-0 items-center gap-0.5 rounded-[8px] px-2.5 text-ui font-bold text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
    >
      {t("mobile2.chat.projects")}
      <ChevronRight className="h-4 w-4" aria-hidden />
    </button>
  ) : undefined;
  return (
    <MobileSheet name="switch" title={title} onClose={onClose} extra={extra}>
      <div className="flex flex-col">
        {SWITCH_SECTIONS.map((section) => {
          const rows = entries.filter((entry) => entry.section === section);
          if (!rows.length) return null;
          return (
            <div key={section} className="flex flex-col">
              {section === "orchestrator" ? null : (
                <MobileSheetSection count={rows.length}>{t(SECTION_LABEL[section])}</MobileSheetSection>
              )}
              {rows.map((entry) => (
                <SwitchRow
                  key={entry.key}
                  t={t}
                  entry={entry}
                  current={entry.key === currentKey}
                  nowMs={nowMs}
                  onPick={() => onPick(entry)}
                />
              ))}
            </div>
          );
        })}
      </div>
    </MobileSheet>
  );
}
