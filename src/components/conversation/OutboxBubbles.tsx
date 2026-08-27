"use client";

import { Clock3, RotateCcw, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";

import { Loader2, X } from "@/components/icons";
import { mdBlocks } from "@/components/feed/markdown";

import { DELIVERY_WAIT_TICK_MS, deliveryWaitFor, deliveryWaitText } from "@/components/runtime/deliveryWait";
import { type TFunction, useLocale } from "@/lib/i18n";

import { cancelOutbox, retryOutbox, type OutboxEntry } from "./outbox";

/**
 * Optimistic user bubbles for the conversation outbox (issue #561).
 *
 * A submitted draft becomes a bubble here the moment it is queued — the same
 * right-aligned shape the transcript uses for a real user message — carrying
 * its own delivery state and, while it has not left for the wire, its cancel.
 * The transcript's own bubble replaces it as soon as it lands, so the feed
 * never shows the message twice.
 */

/**
 * The account switch holding this queue, when one is: `label` is the target's
 * name, or `null` while the annotation has not published one yet (the whole
 * pending window). Display-only — the entry's own `state` is untouched.
 */
export interface SwitchHold {
  label: string | null;
}

function stateChip(
  t: TFunction,
  entry: OutboxEntry,
  switchHold: SwitchHold | null,
  nowMs: number,
): { label: string; icon: React.ReactNode; className: string; wait?: string } {
  /* An unsettled message on a switching card is held for the successor, and its
     bubble is the ONE place that says so. A bare "Delivering" left the operator
     with a spinner and no reason during the exact window the card is hardest to
     follow — while a second statement elsewhere would put this message back on
     the card twice. A settled entry keeps its own word: a failure must stay a
     failure, with its retry. */
  const held = switchHold && (entry.state === "delivering" || entry.state === "queued");
  if (held) {
    return {
      label: switchHold.label
        ? t("outbox.heldForSwitch", { label: switchHold.label })
        : t("outbox.heldForSwitchUnnamed"),
      icon: <Clock3 className="h-3 w-3" aria-hidden />,
      className: "text-warning",
    };
  }
  /* Issue #1213: "Delivering" meant three different things — an attempt on the
     wire, a message parked until the agent's turn ends, and a message nothing
     will ever hand over. The bubble now says which, and how long it waited. */
  if (entry.state === "delivering") {
    const wait = deliveryWaitFor({
      status: entry.awaitingTurn ? "queued" : "delivering",
      firstAttemptAt: new Date(entry.at).toISOString(),
      attempts: 1,
      nowMs,
    });
    const waitLabel = wait ? deliveryWaitText(t, wait) : null;
    if (wait?.phase === "uncertain") {
      return { label: waitLabel!, icon: <TriangleAlert className="h-3 w-3" aria-hidden />, className: "text-danger", wait: wait.phase };
    }
    if (waitLabel) {
      return {
        label: waitLabel,
        icon: <Clock3 className="h-3 w-3" aria-hidden />,
        className: wait!.phase === "awaiting-host" ? "text-danger" : "text-warning",
        wait: wait!.phase,
      };
    }
    return {
      label: t("outbox.delivering"),
      icon: <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" aria-hidden />,
      className: "text-warning",
      wait: "transmitting",
    };
  }
  switch (entry.state) {
    case "failed":
      return {
        label: entry.needsReattach ? t("outbox.reattach") : entry.error ?? t("outbox.failed"),
        icon: <TriangleAlert className="h-3 w-3" aria-hidden />,
        className: "text-danger",
      };
    case "delivered":
      return { label: t("outbox.delivered"), icon: null, className: "text-muted" };
    default:
      return { label: t("outbox.queued"), icon: <Clock3 className="h-3 w-3" aria-hidden />, className: "text-warning" };
  }
}

export function OutboxBubblesView({
  entries,
  t,
  nowMs = 0,
  onCancel,
  onRetry,
  switchHold = null,
}: {
  entries: readonly OutboxEntry[];
  t: TFunction;
  /** Clock the delivery waits are read at (issue #1213). The container ticks
      it; a caller that omits it reads every wait as zero, which renders the
      historical "Delivering" wording and never manufactures a false alarm. */
  nowMs?: number;
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
  switchHold?: SwitchHold | null;
}) {
  if (!entries.length) return null;
  return (
    <div
      data-outbox
      aria-label={t("outbox.queueAria")}
      /* One live region for the whole queue: each state change announces once
         instead of every bubble competing for the same channel. */
      role="log"
      aria-live="polite"
    >
      {entries.map((entry) => {
        const chip = stateChip(t, entry, switchHold, nowMs);
        return (
          <div
            key={entry.id}
            data-outbox-entry={entry.id}
            data-outbox-state={entry.state}
            {...(chip.wait ? { "data-outbox-wait": chip.wait } : {})}
            className="group/msg my-3 flex items-start justify-end gap-1.5"
          >
            <div className="flex max-w-[75%] flex-col items-end gap-1">
              <div className="w-full whitespace-pre-wrap break-words rounded-surface bg-user px-4 py-2.5 opacity-80">
                {/* The same markdown grammar the transcript's own user bubble
                    uses, so nothing changes appearance when it replaces this
                    one — and a link the operator pasted is a link right away. */}
                {mdBlocks(entry.text)}
                {entry.images ? (
                  <span className="mt-1 block text-caption font-semibold text-muted">
                    {t("composer.imagesCount", { count: entry.images })}
                  </span>
                ) : null}
              </div>
              <div className={`flex items-center gap-1 text-caption font-semibold ${chip.className}`}>
                {chip.icon}
                <span data-outbox-status className="min-w-0 truncate">{chip.label}</span>
                {/* A failed message that carried its payload can be retried in
                    place: the entry re-queues under its ORIGINAL idempotency key,
                    so the dispatcher replays it idempotently (round-1 P1#4). */}
                {(entry.state === "failed" || chip.wait === "uncertain") && !entry.needsReattach ? (
                  <button
                    type="button"
                    data-outbox-retry={entry.id}
                    aria-label={t("outbox.retry")}
                    title={t("outbox.retry")}
                    onClick={() => onRetry(entry.id)}
                    className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11"
                  >
                    <RotateCcw className="h-3 w-3" aria-hidden />
                  </button>
                ) : null}
                {/* Only a message that has not left for the wire can be taken
                    back — cancelling a delivering send would be a lie. */}
                {entry.state === "queued" || entry.state === "failed" || chip.wait === "uncertain" ? (
                  <button
                    type="button"
                    data-outbox-cancel={entry.id}
                    aria-label={t("outbox.cancel")}
                    title={t("outbox.cancel")}
                    onClick={() => onCancel(entry.id)}
                    className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11"
                  >
                    <X className="h-3 w-3" aria-hidden />
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function OutboxBubbles({
  cardId,
  entries,
  switchHold = null,
}: {
  cardId: string;
  entries: readonly OutboxEntry[];
  switchHold?: SwitchHold | null;
}) {
  const { t } = useLocale();
  /* A wait only becomes news by getting older, and nothing else re-renders the
     bubble while a message is parked. One local interval, no store, no bus. */
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), DELIVERY_WAIT_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return (
    <OutboxBubblesView
      entries={entries}
      t={t}
      nowMs={nowMs}
      onCancel={(id) => cancelOutbox(cardId, id)}
      onRetry={(id) => retryOutbox(cardId, id)}
      switchHold={switchHold}
    />
  );
}
