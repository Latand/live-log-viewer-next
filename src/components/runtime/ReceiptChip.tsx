"use client";

import { Clock3 } from "lucide-react";

import { X } from "@/components/icons";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { useLocale, type TFunction } from "@/lib/i18n";

import { deliveryWaitText, type DeliveryWait } from "./deliveryWait";
import { humanReceiptReasonKey, receiptIsTerminal, type ReceiptStatus, type RuntimeReceipt } from "./runtimeModel";

/** Human sentence for a rejected/failed reason: a mapped sentence for a known
    code, else the sanitized reason printed verbatim behind a "not delivered:"
    prefix — never the raw `rejected: dead-host` stream (design §7). */
export function humanReason(t: TFunction, reason: string | null | undefined): string {
  const key = humanReceiptReasonKey(reason);
  if (key) return t(key);
  return reason ? t("receipt.human.verbatim", { reason }) : t("composer.receiptFailed");
}

/** Badge tone per receipt status. Text carries the meaning; color reinforces. */
function tone(status: ReceiptStatus): BadgeTone {
  if (status === "rejected" || status === "failed") return "danger";
  if (status === "delivered" || status === "applied" || status === "answered") return "success";
  if (status === "uncertain") return "warning";
  return "neutral";
}

export function runtimeReceiptStatusText(t: TFunction, receipt: RuntimeReceipt): string {
  switch (receipt.status) {
    case "queued":
      return typeof receipt.queuePosition === "number"
        ? t("runtime.receipt.queuedPos", { position: receipt.queuePosition })
        : t("runtime.receipt.queued");
    case "rejected":
    case "failed":
      return humanReason(t, receipt.reason);
    default:
      return t(`runtime.receipt.${receipt.status}`);
  }
}

export interface ReceiptChipProps {
  receipt: RuntimeReceipt;
  /** The delivery wait this receipt is in (issue #1213), when it is unsettled.
      Absent for a settled receipt, whose own status carries the meaning. */
  wait?: DeliveryWait | null;
  actionsDisabled?: boolean;
  /** Retry reuses the same idempotency key — never a second send. */
  onRetry?: () => void;
  /** Edit-and-resend mints a fresh key. */
  onEdit?: () => void;
  /** Give up on a delivery that never arrived (#1213): terminalizes it server
      side so the parked message can no longer be handed over. */
  onDiscard?: () => void;
}

/**
 * Inline command receipt shown on the message it belongs to. Durable and
 * journaled, so it survives a reload. `rejected`/`failed` expose the reason
 * verbatim and are announced politely; both offer Retry (same key) and Edit
 * (new key).
 */
export function ReceiptChip({ receipt, wait = null, actionsDisabled = false, onRetry, onEdit, onDiscard }: ReceiptChipProps) {
  const { t } = useLocale();
  const failed = receipt.status === "rejected" || receipt.status === "failed";
  /* Issue #1213: a delivery unconfirmed past the bound is terminal here even
     though the receipt is not — the composer stops claiming it is moving, and
     an operator control takes over from a spinner that had no exit. */
  const uncertain = wait?.phase === "uncertain";
  const waitText = wait ? deliveryWaitText(t, wait, receipt.queuePosition) : null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 text-[11px] font-semibold" data-operation={receipt.operationId}>
      <Badge
        tone={uncertain || wait?.phase === "awaiting-host"
          ? "danger"
          : wait?.phase === "awaiting-turn" ? "warning" : tone(receipt.status)}
        data-receipt-status={receipt.status}
        {...(wait ? { "data-receipt-wait": wait.phase } : {})}
        {...(failed || uncertain ? { role: "status", "aria-live": "polite" as const } : {})}
      >
        {wait?.phase === "awaiting-turn" || wait?.phase === "awaiting-host" ? (
          <Clock3 className="mr-1 h-3 w-3" aria-hidden />
        ) : null}
        {waitText ?? runtimeReceiptStatusText(t, receipt)}
      </Badge>
      {/* The exit the operator never had. Retry abandons the parked attempt
          server side before it mints a replacement, so pressing it cannot put
          the same message into the agent's turn twice. */}
      {uncertain && onRetry ? (
        <button
          type="button"
          disabled={actionsDisabled}
          data-receipt-uncertain-retry
          className="min-h-11 rounded-full border border-border bg-canvas px-3 py-0.5 text-muted hover:border-accent/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50 sm:min-h-0 sm:px-2"
          onClick={onRetry}
        >
          {t("runtime.receipt.retry")}
        </button>
      ) : null}
      {uncertain && onDiscard ? (
        <button
          type="button"
          disabled={actionsDisabled}
          data-receipt-discard
          aria-label={t("runtime.receipt.discard")}
          title={t("runtime.receipt.discard")}
          className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded text-muted hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50 sm:min-h-0 sm:min-w-0 sm:px-0.5"
          onClick={onDiscard}
        >
          <X className="h-3 w-3" aria-hidden />
        </button>
      ) : null}
      {failed && onRetry ? (
        <button
          type="button"
          disabled={actionsDisabled}
          className="min-h-11 rounded-full border border-border bg-canvas px-3 py-0.5 text-muted hover:border-accent/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50 sm:min-h-0 sm:px-2"
          onClick={onRetry}
        >
          {t("runtime.receipt.retry")}
        </button>
      ) : null}
      {failed && onEdit ? (
        <button
          type="button"
          disabled={actionsDisabled}
          className="min-h-11 rounded-full border border-border bg-canvas px-3 py-0.5 text-muted hover:border-accent/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50 sm:min-h-0 sm:px-2"
          onClick={onEdit}
        >
          {t("runtime.receipt.edit")}
        </button>
      ) : null}
      {/* The live pulse means "moving right now". A message parked at a turn
          boundary is not moving, and one nothing will confirm never was. */}
      {!receiptIsTerminal(receipt.status)
        && receipt.status !== "pending"
        && (!wait || wait.phase === "transmitting") ? (
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted motion-reduce:animate-none" aria-hidden />
      ) : null}
    </span>
  );
}
