"use client";

import { Clock3, TriangleAlert } from "lucide-react";

import { Loader2, X } from "@/components/icons";

import { type TFunction, useLocale } from "@/lib/i18n";

import { cancelOutbox, type OutboxEntry } from "./outbox";

/**
 * Optimistic user bubbles for the conversation outbox (issue #561).
 *
 * A submitted draft becomes a bubble here the moment it is queued — the same
 * right-aligned shape the transcript uses for a real user message — carrying
 * its own delivery state and, while it has not left for the wire, its cancel.
 * The transcript's own bubble replaces it as soon as it lands, so the feed
 * never shows the message twice.
 */

function stateChip(t: TFunction, entry: OutboxEntry): { label: string; icon: React.ReactNode; className: string } {
  switch (entry.state) {
    case "delivering":
      return {
        label: t("outbox.delivering"),
        icon: <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" aria-hidden />,
        className: "text-warning",
      };
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
  onCancel,
}: {
  entries: readonly OutboxEntry[];
  t: TFunction;
  onCancel: (id: string) => void;
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
        const chip = stateChip(t, entry);
        return (
          <div
            key={entry.id}
            data-outbox-entry={entry.id}
            data-outbox-state={entry.state}
            className="group/msg my-3 flex items-start justify-end gap-1.5"
          >
            <div className="flex max-w-[75%] flex-col items-end gap-1">
              <div className="w-full whitespace-pre-wrap break-words rounded-surface bg-user px-4 py-2.5 opacity-80">
                {entry.text}
                {entry.images ? (
                  <span className="mt-1 block text-caption font-semibold text-muted">
                    {t("composer.imagesCount", { count: entry.images })}
                  </span>
                ) : null}
              </div>
              <div className={`flex items-center gap-1 text-caption font-semibold ${chip.className}`}>
                {chip.icon}
                <span data-outbox-status className="min-w-0 truncate">{chip.label}</span>
                {/* Only a message that has not left for the wire can be taken
                    back — cancelling a delivering send would be a lie. */}
                {entry.state === "queued" || entry.state === "failed" ? (
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

export function OutboxBubbles({ cardId, entries }: { cardId: string; entries: readonly OutboxEntry[] }) {
  const { t } = useLocale();
  return <OutboxBubblesView entries={entries} t={t} onCancel={(id) => cancelOutbox(cardId, id)} />;
}
