"use client";

import { CircleCheck, CircleX, Clock3, LoaderCircle, RotateCcw } from "lucide-react";

import { type MessageKey, type TFunction, useLocale } from "@/lib/i18n";
import type { StructuredSpawnCardState } from "@/lib/types";

/**
 * Launch and delivery facts as transient compact chips INSIDE the conversation
 * feed (issue #569).
 *
 * The launch is not a card type. It is the same conversation in an earlier
 * state, so its status never replaces the window: it rides at the tail of the
 * transcript, beside the operator's own optimistic bubbles, and disappears once
 * it stops being news. A failed launch keeps its retry here, where the operator
 * is already looking.
 */

const STATE_ICON = {
  starting: LoaderCircle,
  binding: LoaderCircle,
  queued: Clock3,
  reconciling: LoaderCircle,
  "recoverable-timeout": Clock3,
  "live-late-success": CircleCheck,
  failed: CircleX,
  recovered: CircleCheck,
} as const;

type LaunchState = StructuredSpawnCardState["state"];

function tone(state: LaunchState): string {
  if (state === "failed") return "border-danger/45 bg-danger-soft text-danger";
  if (state === "live-late-success" || state === "recovered") return "border-success/45 bg-success-soft text-success";
  if (state === "queued" || state === "recoverable-timeout") return "border-warning/45 bg-warning-soft text-warning";
  return "border-border bg-sunken text-secondary";
}

function spinning(state: LaunchState): boolean {
  return state === "starting" || state === "binding" || state === "reconciling";
}

export function LaunchChipsView({
  launch,
  t,
  onRetry,
}: {
  launch: StructuredSpawnCardState;
  t: TFunction;
  onRetry?: () => void;
}) {
  const Icon = STATE_ICON[launch.state];
  /* Every chip's full sentence stays available as its tooltip and to screen
     readers, so compacting the face never removes the explanation. */
  const detail = t(`spawnCard.${launch.state}` as MessageKey);
  const initialDetail = t(`spawnCard.initial.${launch.initialMessage}` as MessageKey);
  return (
    <div
      data-launch-chips
      data-launch-state={launch.state}
      data-launch-initial={launch.initialMessage}
      className="my-2 flex flex-wrap items-center gap-1.5"
      role="status"
      aria-live={launch.state === "failed" ? "assertive" : "polite"}
    >
      <span
        data-launch-chip="state"
        title={detail}
        className={`inline-flex min-w-0 max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-caption font-semibold ${tone(launch.state)}`}
      >
        <Icon
          className={`h-3 w-3 shrink-0 ${spinning(launch.state) ? "animate-spin motion-reduce:animate-none" : ""}`}
          aria-hidden
        />
        <span className="truncate">{t(`spawnChip.${launch.state}` as MessageKey)}</span>
        <span className="sr-only">{detail}</span>
      </span>
      <span
        data-launch-chip="initial"
        title={initialDetail}
        className="inline-flex min-w-0 max-w-full items-center rounded-full border border-border bg-sunken px-2 py-0.5 text-caption font-semibold text-muted"
      >
        <span className="truncate">{t(`spawnChip.initial.${launch.initialMessage}` as MessageKey)}</span>
        <span className="sr-only">{initialDetail}</span>
      </span>
      <span
        data-launch-chip="id"
        title={t("spawnCard.launch", { id: launch.launchId })}
        className="inline-flex shrink-0 items-center rounded-full border border-border/70 px-2 py-0.5 font-mono text-caption text-muted/80"
      >
        {launch.launchId.slice(0, 8)}
      </span>
      {launch.error ? (
        <span data-launch-chip="error" className="min-w-0 basis-full break-words text-caption font-semibold text-danger">
          {launch.error}
        </span>
      ) : null}
      {launch.state === "failed" && launch.retrySafe && onRetry ? (
        <button
          type="button"
          data-launch-retry
          onClick={onRetry}
          title={t("spawnCard.retrySafe")}
          className="inline-flex min-h-8 shrink-0 items-center gap-1 rounded-full border border-border bg-card px-2 text-caption font-semibold text-primary hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 [@media(pointer:coarse)]:min-h-11"
        >
          <RotateCcw className="h-3 w-3" aria-hidden /> {t("launchHistory.retryLabel")}
        </button>
      ) : null}
    </div>
  );
}

export function LaunchChips({ launch, onRetry }: { launch: StructuredSpawnCardState; onRetry?: () => void }) {
  const { t } = useLocale();
  return <LaunchChipsView launch={launch} t={t} onRetry={onRetry} />;
}
