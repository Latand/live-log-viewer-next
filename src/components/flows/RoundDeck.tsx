"use client";

import { useMemo, useState } from "react";

import type { Flow, Round } from "@/lib/flows/types";
import { type TFunction, useLocale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

import { BranchPane } from "@/components/BranchPane";

import { VERDICT_GLYPHS, verdictTone } from "./flowModel";
import { RoundStateIcon } from "./RoundIcons";

/* Vertical rhythm of the card spines peeking from under the front card. */
const TAB_H = 26;
const TAB_STEP = 30;
/* Spines visible before the rest collapses into a «+N» tail. */
const TAB_MAX = 5;

export interface DeckRound {
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
      className={`deck-tab absolute inset-x-0 flex items-center gap-1.5 rounded-[9px] border bg-panel px-2.5 text-left shadow-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
        pulse ? "deck-tab-live border-ok/50" : "border-line hover:border-accent/45"
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
      <span className="min-w-0 flex-1 truncate text-[10.5px] font-semibold text-dim">
        {round.error ? t("roundDeck.aborted") : round.verdict ? round.verdict : t("roundDeck.reviewInProgress")}
        {round.findingsCount != null && round.findingsCount > 0 ? ` · ${t("roundDeck.findings", { count: round.findingsCount })}` : ""}
      </span>
      {pulse ? <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-ok" aria-hidden /> : null}
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
  files,
  onSelect,
  focusRound,
  dormant = false,
}: {
  flow: Flow;
  rounds: DeckRound[];
  files: FileEntry[];
  onSelect: (file: FileEntry) => void;
  /** Round chip clicked on the strip; nonce-encoded as `n + fraction` changes. */
  focusRound: number | null;
  /** Far zoom on the board: the front pane's feed sleeps behind the labels. */
  dormant?: boolean;
}) {
  const { t } = useLocale();
  const latest = rounds.length ? rounds[rounds.length - 1]! : null;
  /* Ephemeral by design: on reload the live round is in front again. */
  const [frontN, setFrontN] = useState<number | null>(null);
  /* State adjustments happen during render (no effects): a strip chip click
     pulls its round forward, and a freshly started round always surfaces —
     stale manual selection would hide live work. */
  const [seenFocus, setSeenFocus] = useState<number | null>(null);
  if (focusRound != null && focusRound !== seenFocus) {
    setSeenFocus(focusRound);
    setFrontN(Math.round(focusRound));
  }
  const [seenLatest, setSeenLatest] = useState<number | null>(null);
  if (latest && latest.round.n !== seenLatest) {
    setSeenLatest(latest.round.n);
    if (frontN != null && latest.round.n > frontN && latest.round.verdict === null) setFrontN(null);
  }
  const front = useMemo(
    () => rounds.find((item) => item.round.n === frontN) ?? latest,
    [rounds, frontN, latest],
  );

  if (!front) {
    return (
      <div className="flex h-full items-center justify-center rounded-[10px] border border-dashed border-[#c9c9d1] bg-panel/60">
        <span className="text-[12px] font-semibold text-dim">{t("roundDeck.waitingFirst")}</span>
      </div>
    );
  }

  const stacked = rounds.filter((item) => item.round.n !== front.round.n).reverse();
  const shown = stacked.slice(0, TAB_MAX);
  const hidden = stacked.length - shown.length;
  const tone = verdictTone(front.round.verdict);
  const finished = front.round.verdict !== null || !!front.round.error;
  const liveBehind =
    latest && front.round.n !== latest.round.n && latest.round.verdict === null && !latest.round.error
      ? latest
      : null;

  return (
    <div className="deck-3d relative h-full" style={{ paddingBottom: Math.min(stacked.length, TAB_MAX + (hidden ? 1 : 0)) * TAB_STEP }}>
      {/* Front card. Key by round: swapping rounds remounts the pane with the
          scheme fade instead of morphing one feed into another. */}
      <div key={front.round.n} className="scheme-enter relative z-[11] flex h-full flex-col">
        {front.file ? (
          <BranchPane
            file={front.file}
            files={files}
            tasks={[]}
            onSelect={onSelect}
            isRoot={false}
            dormant={dormant}
            noComposer={flow.reviewerMode === "headless" || finished}
            banner={
              <div
                className="flex h-6 shrink-0 items-center gap-1.5 border-b border-line px-2.5 text-[10.5px] font-bold"
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
          <div className="flex h-full flex-col items-center justify-center gap-1 rounded-[10px] border border-line bg-panel shadow-card">
            <span className="text-[12px] font-semibold text-dim">{roundLabel(t, front.round)}</span>
            <span className="text-[11px] text-dim">
              {front.round.error ? front.round.error : t("roundDeck.spawningReviewer")}
            </span>
          </div>
        )}
      </div>

      {shown.map((item, index) => (
        <RoundTab
          key={item.round.n}
          round={item.round}
          depth={index}
          pulse={liveBehind?.round.n === item.round.n}
          onPull={() => setFrontN(item.round.n)}
        />
      ))}
      {hidden > 0 ? (
        <div
          className="pointer-events-none absolute inset-x-6 flex items-center justify-center rounded-[9px] border border-line bg-panel/70 text-[10px] font-semibold text-dim shadow-card"
          style={{ height: TAB_H, bottom: -(shown.length * TAB_STEP) - 8, zIndex: 10 - shown.length }}
          aria-hidden
        >
          {t("roundDeck.moreRounds", { count: hidden })}
        </div>
      ) : null}
    </div>
  );
}
