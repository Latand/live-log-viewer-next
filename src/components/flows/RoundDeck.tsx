"use client";

import { useEffect, useMemo, useState } from "react";

import type { Flow, Round } from "@/lib/flows/types";
import { type TFunction, useLocale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

import { BranchPane } from "@/components/BranchPane";
import { ChevronDown, FoldVertical } from "@/components/icons";

import { VERDICT_GLYPHS, verdictTone } from "./flowModel";
import { RoundStateIcon } from "./RoundIcons";

/* Vertical rhythm of the card spines peeking from under the front card. */
const TAB_H = 26;
const TAB_STEP = 30;
/* Spines visible before the rest collapses into a «+N» tail. */
const TAB_MAX = 5;

export function reviewDeckCollapseKey(flowId: string): string {
  return `llvReviewDeckCollapsed:${flowId}`;
}

export interface DeckRound {
  key: string;
  round: Round;
  file: FileEntry | null;
}

function roundLabel(t: TFunction, round: Round): string {
  if (round.error) return t("roundDeck.roundAborted", { n: round.n });
  if (round.verdict) return t("roundDeck.roundVerdict", { n: round.n, verdict: `${VERDICT_GLYPHS[round.verdict]} ${round.verdict}` });
  return t("roundDeck.roundInProgress", { n: round.n });
}

/** Spine of a stacked (non-front) round: pull it to bring the round forward. */
function RoundTab({
  round,
  depth,
  pulse,
  onPull,
}: {
  round: Round;
  depth: number;
  pulse: boolean;
  onPull: () => void;
}) {
  const { t } = useLocale();
  const tone = verdictTone(round.verdict);
  return (
    <button
      className={`deck-tab absolute inset-x-0 flex items-center gap-1.5 rounded-[9px] border bg-card px-2.5 text-left shadow-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
        pulse ? "deck-tab-live border-success/50" : "border-border hover:border-accent/45"
      }`}
      style={{
        height: TAB_H + 10,
        bottom: -(depth * TAB_STEP) - 10,
        zIndex: 10 - depth,
        transform: `scale(${1 - depth * 0.035}) translateZ(${-depth * 34}px)`,
      }}
      title={round.error ? `${roundLabel(t, round)}: ${round.error}` : roundLabel(t, round)}
      onClick={onPull}
    >
      <span
        className="inline-flex h-4 shrink-0 items-center gap-1 rounded-full px-1.5 text-[9.5px] font-bold"
        style={{ backgroundColor: tone.soft, color: tone.color }}
      >
        R{round.n} <RoundStateIcon verdict={round.verdict} error={!!round.error} className="h-2.5 w-2.5" />
      </span>
      <span className="min-w-0 flex-1 truncate text-[10.5px] font-semibold text-muted">
        {round.error ? t("roundDeck.aborted") : round.verdict ? round.verdict : t("roundDeck.reviewInProgress")}
        {round.findingsCount != null && round.findingsCount > 0 ? ` · ${t("roundDeck.findings", { count: round.findingsCount })}` : ""}
      </span>
      {pulse ? <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-success" aria-hidden /> : null}
    </button>
  );
}

/**
 * The review-round deck: one scheme-node position holding every reviewer
 * round of a flow. The front card is a live BranchPane; previous rounds lie
 * "under" it as pullable card spines with a perspective fan. Only the front
 * round mounts a feed, so a deep loop history costs nothing.
 */
export function RoundDeck({
  flow,
  rounds,
  focusRound,
  dormant = false,
}: {
  flow: Flow;
  rounds: DeckRound[];
  /** Round chip clicked on the strip; nonce-encoded as `n + fraction` changes. */
  focusRound: number | null;
  /** Far zoom on the board: the front pane's feed sleeps behind the labels. */
  dormant?: boolean;
}) {
  const { t } = useLocale();
  const latest = rounds.length ? rounds[rounds.length - 1]! : null;
  const collapseKey = reviewDeckCollapseKey(flow.id);
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- hydrate the owner-controlled local board preference after SSR.
    setCollapsed(window.localStorage.getItem(collapseKey) === "1");
  }, [collapseKey]);
  const setDeckCollapsed = (value: boolean) => {
    setCollapsed(value);
    if (value) window.localStorage.setItem(collapseKey, "1");
    else window.localStorage.removeItem(collapseKey);
  };
  /* Ephemeral by design: on reload the live round is in front again. */
  const [frontKey, setFrontKey] = useState<string | null>(null);
  /* State adjustments happen during render (no effects): a strip chip click
     pulls its round forward, and a freshly started round always surfaces —
     stale manual selection would hide live work. */
  const [seenFocus, setSeenFocus] = useState<number | null>(null);
  if (focusRound != null && focusRound !== seenFocus) {
    setSeenFocus(focusRound);
    const focused = rounds.findLast((item) => item.round.n === Math.round(focusRound));
    setFrontKey(focused?.key ?? null);
  }
  const [seenLatest, setSeenLatest] = useState<string | null>(null);
  if (latest && latest.key !== seenLatest) {
    setSeenLatest(latest.key);
    if (frontKey != null && latest.round.verdict === null) setFrontKey(null);
  }
  const front = useMemo(
    () => rounds.find((item) => item.key === frontKey) ?? latest,
    [rounds, frontKey, latest],
  );

  if (!front) {
    return (
      <div className="flex h-full items-center justify-center rounded-[10px] border border-dashed border-strong bg-card/60">
        <span className="text-[12px] font-semibold text-muted">{t("roundDeck.waitingFirst")}</span>
      </div>
    );
  }

  const stacked = rounds.filter((item) => item.key !== front.key).reverse();
  const shown = stacked.slice(0, TAB_MAX);
  const hidden = stacked.length - shown.length;
  const tone = verdictTone(front.round.verdict);
  const finished = front.round.verdict !== null || !!front.round.error;
  const liveBehind =
    latest && front.key !== latest.key && latest.round.verdict === null && !latest.round.error
      ? latest
      : null;
  const collapseControl = (
    <button
      type="button"
      data-review-deck-collapse
      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] border border-border bg-canvas text-muted shadow-1 hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      aria-label={t("roundDeck.collapseStack", { count: rounds.length })}
      title={t("roundDeck.collapseStack", { count: rounds.length })}
      onClick={() => setDeckCollapsed(true)}
    >
      <FoldVertical className="h-3.5 w-3.5" aria-hidden />
    </button>
  );

  if (collapsed) {
    return (
      <button
        type="button"
        data-review-deck-collapsed
        className="flex h-12 w-full items-center gap-2 rounded-[10px] border border-border bg-card px-3 text-left shadow-1 hover:border-accent/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        aria-label={t("roundDeck.expandStack", { count: rounds.length })}
        title={t("roundDeck.expandStack", { count: rounds.length })}
        onClick={() => setDeckCollapsed(false)}
      >
        <span className="inline-flex h-6 shrink-0 items-center rounded-full px-2 text-[10px] font-bold" style={{ backgroundColor: tone.soft, color: tone.color }}>
          {t("roundDeck.roundsCount", { count: rounds.length })}
        </span>
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-muted">
          {front.round.error ? t("roundDeck.aborted") : front.round.verdict ?? t("roundDeck.reviewInProgress")}
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-accent" aria-hidden />
      </button>
    );
  }

  return (
    <div className="deck-3d relative h-full" style={{ paddingBottom: Math.min(stacked.length, TAB_MAX + (hidden ? 1 : 0)) * TAB_STEP }}>
      {/* Front card. Key by round: swapping rounds remounts the pane with the
          scheme fade instead of morphing one feed into another. */}
      <div key={front.key} className="scheme-enter relative z-[11] flex h-full flex-col">
        {front.file ? (
          <BranchPane
            file={front.file}
            tasks={[]}
            isRoot={false}
            dormant={dormant}
            noComposer={flow.reviewerMode === "headless" || finished}
            headerActions={collapseControl}
            banner={
              <div
                className="flex h-6 shrink-0 items-center gap-1.5 border-b border-border px-2.5 text-[10.5px] font-bold"
                style={{ backgroundColor: tone.soft, color: tone.color }}
              >
                {roundLabel(t, front.round)}
                {front.round.findingsCount != null && front.round.findingsCount > 0 ? (
                  <span className="font-semibold opacity-80">· {t("roundDeck.findings", { count: front.round.findingsCount })}</span>
                ) : null}
                {front.round.readyNote ? (
                  <span className="min-w-0 flex-1 truncate font-semibold opacity-70" title={front.round.readyNote}>
                    · {front.round.readyNote}
                  </span>
                ) : null}
              </div>
            }
          />
        ) : (
          <div className="relative flex h-full flex-col items-center justify-center gap-1 rounded-[10px] border border-border bg-card shadow-1">
            <div className="absolute right-1.5 top-1.5">{collapseControl}</div>
            <span className="text-[12px] font-semibold text-muted">{roundLabel(t, front.round)}</span>
            <span className="text-[11px] text-muted">
              {front.round.error ? front.round.error : t("roundDeck.spawningReviewer")}
            </span>
          </div>
        )}
      </div>

      {shown.map((item, index) => (
        <RoundTab
          key={item.key}
          round={item.round}
          depth={index}
          pulse={liveBehind?.key === item.key}
          onPull={() => setFrontKey(item.key)}
        />
      ))}
      {hidden > 0 ? (
        <div
          className="pointer-events-none absolute inset-x-6 flex items-center justify-center rounded-[9px] border border-border bg-card/70 text-[10px] font-semibold text-muted shadow-1"
          style={{ height: TAB_H, bottom: -(shown.length * TAB_STEP) - 8, zIndex: 10 - shown.length }}
          aria-hidden
        >
          {t("roundDeck.moreRounds", { count: hidden })}
        </div>
      ) : null}
    </div>
  );
}
