"use client";

import { useEffect, useRef, useState } from "react";

import type { DeviceAttentionOffer } from "@/lib/attention/service";
import type { AttentionRequestV1 } from "@/lib/attention/types";
import type { TFunction } from "@/lib/i18n";
import {
  arrangementFor,
  DESKTOP_IDENTITY_DOT,
  DESKTOP_MIC_SIZE,
  desktopBands,
  MOBILE_IDENTITY_DOT,
  MOBILE_MIC_SIZE,
  MOBILE_SECONDARY_SIZE,
  sheetBands,
  type OverlayArrangement,
  type OverlayBands,
} from "@/lib/overlay/layout";
import type { DigestChip } from "@/lib/overlay/digest";
import { buildOverlayTimeline, type ContinuityEntry, type OverlayTurn, type TimelineDensity } from "@/lib/overlay/timeline";

import { AttentionActionRow, type AttentionPreview } from "./AttentionActionRow";
import { agentStateLabel, IdentityDot, type AgentState } from "./IdentityDot";

/**
 * The persistent root-conversation overlay (#691) — ONE component.
 *
 * D2 gives it three renderings: a desktop document Picture-in-Picture window,
 * the identical component docked in the page, and a mobile sheet. This file is
 * the component; the renderings only supply a container and a measured size.
 * Nothing here owns the conversation state, and nothing here decides which
 * conversation it is: the overlay is permanently bound to the root (D1), never
 * follows the focused worker, and offers no way to change who is speaking.
 *
 * Deliberately absent, and each omission is load-bearing: project navigation,
 * the board, any conversation switcher, per-message toolbars, settings, and any
 * avatar beyond the identity dot. Every one of those exists in the Viewer
 * already, and every one of them is how this window would quietly become a
 * small second Viewer.
 */

export interface RootOverlayProps {
  /** Which rendering this is. Only the surface differs; the state is one. */
  surface: "window" | "dock" | "sheet";
  /** Measured, never declared: on desktop the arrangement switches on height,
      so resizing the window IS the expand gesture. */
  height: number;
  state: AgentState;
  turns: readonly OverlayTurn[];
  chips?: readonly DigestChip[];
  continuity?: ContinuityEntry | null;
  attention?: DeviceAttentionOffer | null;
  attentionPreview?: AttentionPreview | null;
  /** This device's last answer was refused by the record; the action row says
      so rather than leaving the operator with a control that did nothing. */
  attentionRefused?: boolean;
  /** Which refusal it was, when the surface knows. */
  attentionRefusedReason?: string | null;
  /** Take the refusal band off screen. */
  onDismissAttentionRefusal?: () => void;
  autoFollow?: { scope: "session" | "project"; label: string } | null;
  /** Sheet only: Rail collapses the timeline to a single line. */
  density?: TimelineDensity;
  atTail?: boolean;
  lastSeenTurnId?: string | null;
  micLevel?: () => number;
  reducedMotion?: boolean;
  /** Present only while something is running. */
  onStop?: () => void;
  /** Shown only when true — a row of permanently inert indicators is how a calm
      surface turns into a status board. */
  computerUse?: boolean;
  permissionPending?: boolean;
  /** The one control that crosses the window/page boundary. */
  onToggleDock?: () => void;
  onSend?: (text: string) => void;
  onFollowLatest?: () => void;
  onOpenPreviousSession?: (conversationId: string) => void;
  onExpandChips?: () => void;
  onChipCommand?: (chip: DigestChip) => void;
  onAcceptAttention: (request: AttentionRequestV1) => void;
  onPreviewAttention: (request: AttentionRequestV1) => void;
  onDeclineAttention: (request: AttentionRequestV1) => void;
  /** Closing a preview — a refusal after looking, which the record keeps apart
      from refusing unseen. */
  onDismissAttention: (request: AttentionRequestV1) => void;
  onReturnAttention: (request: AttentionRequestV1) => void;
  onRevokeAutoFollow?: () => void;
  t: TFunction;
}

function densityFor(surface: RootOverlayProps["surface"], arrangement: OverlayArrangement, density?: TimelineDensity): TimelineDensity {
  if (surface === "sheet") return density ?? "expanded";
  return arrangement;
}

export function RootOverlay(props: RootOverlayProps) {
  const {
    surface, height, state, turns, chips, continuity, attention, attentionPreview, attentionRefused, autoFollow,
    atTail, lastSeenTurnId, micLevel, reducedMotion = false, onStop, computerUse, permissionPending,
    onToggleDock, onSend, onFollowLatest, onOpenPreviousSession, onExpandChips, onChipCommand, t,
  } = props;

  const mobile = surface === "sheet";
  const arrangement = arrangementFor(height);
  const density = densityFor(surface, arrangement, props.density);
  /* A refusal keeps the band open even when the offer it belonged to has just
     gone terminal — otherwise the one case the operator most needs told about
     would take its own message off screen with it. */
  const hasAction = Boolean(attention && attention.status !== "closed" && attention.status !== "none")
    || Boolean(autoFollow)
    || Boolean(attentionRefused);
  const bands: OverlayBands = mobile ? sheetBands(height, hasAction) : desktopBands(height, hasAction);
  const timeline = buildOverlayTimeline({ density, turns, chips, continuity, atTail, lastSeenTurnId });

  const [draft, setDraft] = useState("");
  const micSize = mobile ? MOBILE_MIC_SIZE : DESKTOP_MIC_SIZE;
  const controlSize = mobile ? MOBILE_SECONDARY_SIZE : 28;

  return (
    <section
      data-testid="root-overlay"
      data-surface={surface}
      data-arrangement={arrangement}
      data-density={density}
      aria-label={t("overlay.title")}
      className="flex min-h-0 flex-col overflow-hidden bg-card text-primary"
      style={{ height }}
    >
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header
        className="flex shrink-0 items-center gap-2 border-b border-border px-2"
        style={{ height: bands.header }}
        data-testid="overlay-header"
      >
        <IdentityDot
          state={state}
          size={mobile ? MOBILE_IDENTITY_DOT : DESKTOP_IDENTITY_DOT}
          level={micLevel}
          reducedMotion={reducedMotion}
          t={t}
        />
        {/* Every state the dot expresses is also the text beside it. */}
        <span className="text-caption text-secondary" data-testid="overlay-state">{agentStateLabel(state, t)}</span>
        {timeline.foldedChipCount > 0 && density === "rail" ? (
          <button
            type="button"
            data-testid="overlay-chip-counter"
            onClick={onExpandChips}
            className="rounded-full bg-sunken px-1.5 text-caption text-muted"
          >
            {t("overlay.moreUpdates", { count: timeline.foldedChipCount })}
          </button>
        ) : null}
        <span className="ml-auto flex items-center gap-1.5">
          {permissionPending ? <span className="text-caption text-warning">{t("overlay.permission")}</span> : null}
          {computerUse ? <span className="text-caption text-accent" data-testid="overlay-computer-use">{t("overlay.computerUse")}</span> : null}
          {onStop ? (
            <button type="button" data-testid="overlay-stop" onClick={onStop} className="rounded-control border border-border px-2 text-caption text-secondary">
              {t("overlay.stop")}
            </button>
          ) : null}
          {onToggleDock ? (
            <button
              type="button"
              data-testid="overlay-dock-toggle"
              onClick={onToggleDock}
              aria-label={surface === "window" ? t("overlay.dock") : t("overlay.popOut")}
              className="rounded-control border border-border px-2 text-caption text-secondary"
            >
              {surface === "window" ? t("overlay.dock") : t("overlay.popOut")}
            </button>
          ) : null}
        </span>
      </header>

      {/* ── Timeline ───────────────────────────────────────────────────────── */}
      <div
        className="relative min-h-0 shrink-0 overflow-y-auto px-2"
        style={{ height: bands.timeline }}
        data-testid="overlay-timeline"
      >
        {timeline.continuity ? (
          <button
            type="button"
            data-testid="overlay-continuity"
            onClick={() => onOpenPreviousSession?.(timeline.continuity!.previousConversationId)}
            title={t("overlay.continuedFromHint")}
            className="w-full border-b border-dashed border-border py-1 text-left text-caption text-muted hover:text-secondary"
          >
            {t("overlay.continuedFrom")}
          </button>
        ) : null}

        {timeline.entries.map((entry) => (
          entry.kind === "turn" ? (
            <p
              key={entry.turn.id}
              data-testid="overlay-turn"
              data-role={entry.turn.role}
              data-partial={entry.turn.partial ? "true" : undefined}
              data-clamp={entry.clampLines}
              style={{
                display: "-webkit-box",
                WebkitLineClamp: entry.clampLines,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
              }}
              className={`py-0.5 text-caption ${entry.turn.partial ? "text-muted" : "text-primary"}`}
            >
              {entry.turn.text}
            </p>
          ) : (
            /* One line, a state word, a timestamp — never a message, and never
               anything beyond the journal's own operator-safe summary. */
            <button
              key={entry.chip.eventId}
              type="button"
              data-testid="overlay-chip"
              data-class={entry.chip.digestClass}
              onClick={() => onChipCommand?.(entry.chip)}
              className={`block w-full truncate rounded-[6px] px-1 py-0.5 text-left text-caption ${
                entry.chip.digestClass === "prompt" ? "bg-warning-soft text-secondary" : "text-muted"
              }`}
            >
              {entry.chip.summary}
            </button>
          )
        ))}

        {timeline.foldedChipCount > 0 && density === "compact" ? (
          <button
            type="button"
            data-testid="overlay-chip-counter"
            onClick={onExpandChips}
            className="block w-full px-1 text-left text-caption text-muted underline"
          >
            {t("overlay.moreUpdates", { count: timeline.foldedChipCount })}
          </button>
        ) : null}

        {timeline.newCount > 0 ? (
          <button
            type="button"
            data-testid="overlay-new-turns"
            onClick={onFollowLatest}
            className="sticky bottom-0 mx-auto block rounded-full bg-accent px-2 py-0.5 text-caption text-on-accent"
          >
            {t("overlay.newTurns", { count: timeline.newCount })}
          </button>
        ) : null}
      </div>

      {/* ── Action row: 0px until something needs an answer ─────────────────── */}
      {hasAction ? (
        <div className="shrink-0 border-t border-border" style={{ minHeight: bands.actionRow }} data-testid="overlay-action-row">
          <AttentionActionRow
            offer={attention ?? null}
            preview={attentionPreview ?? null}
            autoFollow={autoFollow ?? null}
            refused={attentionRefused}
            refusedReason={props.attentionRefusedReason ?? null}
            onDismissRefusal={props.onDismissAttentionRefusal}
            controlSize={controlSize}
            onAccept={props.onAcceptAttention}
            onPreview={props.onPreviewAttention}
            onDecline={props.onDeclineAttention}
            onDismiss={props.onDismissAttention}
            onReturn={props.onReturnAttention}
            onRevokeAutoFollow={props.onRevokeAutoFollow}
            t={t}
          />
        </div>
      ) : null}

      {/* ── Composer ───────────────────────────────────────────────────────── */}
      <form
        className="flex shrink-0 items-center gap-2 border-t border-border px-2"
        style={{ height: bands.composer }}
        data-testid="overlay-composer"
        onSubmit={(event) => {
          event.preventDefault();
          if (!draft.trim()) return;
          onSend?.(draft.trim());
          setDraft("");
        }}
      >
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          aria-label={t("overlay.composer")}
          placeholder={t("overlay.composer")}
          className="min-w-0 flex-1 bg-transparent text-caption outline-none"
        />
        <button
          type="submit"
          data-testid="overlay-mic"
          aria-label={t("overlay.send")}
          style={{ width: micSize, height: micSize }}
          className="shrink-0 rounded-full bg-accent text-on-accent"
        >
          ●
        </button>
      </form>
    </section>
  );
}

/** Measure a container and hand back its height, so the arrangement is a fact
    about the window rather than a mode somebody has to set. */
export function useMeasuredHeight(initial: number): [number, (node: HTMLElement | null) => void] {
  const [height, setHeight] = useState(initial);
  const observed = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const node = observed.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const measured = entries[0]?.contentRect.height;
      if (typeof measured === "number" && measured > 0) setHeight(measured);
    });
    observer.observe(node);
    return () => observer.disconnect();
  });

  return [height, (node) => { observed.current = node; }];
}
