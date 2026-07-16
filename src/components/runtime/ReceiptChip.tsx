"use client";

import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { useLocale, type TFunction } from "@/lib/i18n";

import { receiptIsTerminal, type ReceiptStatus, type RuntimeReceipt } from "./runtimeModel";

/** Badge tone per receipt status. Text carries the meaning; color reinforces. */
function tone(status: ReceiptStatus): BadgeTone {
  if (status === "rejected" || status === "failed") return "danger";
  if (status === "delivered" || status === "answered") return "success";
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
      return t("runtime.receipt.rejected", { reason: receipt.reason ?? "" });
    case "failed":
      return t("runtime.receipt.failed", { reason: receipt.reason ?? "" });
    default:
      return t(`runtime.receipt.${receipt.status}`);
  }
}

export interface ReceiptChipProps {
  receipt: RuntimeReceipt;
  actionsDisabled?: boolean;
  /** Retry reuses the same idempotency key — never a second send. */
  onRetry?: () => void;
  /** Edit-and-resend mints a fresh key. */
  onEdit?: () => void;
}

/**
 * Inline command receipt shown on the message it belongs to. Durable and
 * journaled, so it survives a reload. `rejected`/`failed` expose the reason
 * verbatim and are announced politely; both offer Retry (same key) and Edit
 * (new key).
 */
export function ReceiptChip({ receipt, actionsDisabled = false, onRetry, onEdit }: ReceiptChipProps) {
  const { t } = useLocale();
  const failed = receipt.status === "rejected" || receipt.status === "failed";
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 text-[11px] font-semibold" data-operation={receipt.operationId}>
      <Badge
        tone={tone(receipt.status)}
        data-receipt-status={receipt.status}
        {...(failed ? { role: "status", "aria-live": "polite" as const } : {})}
      >
        {runtimeReceiptStatusText(t, receipt)}
      </Badge>
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
      {!receiptIsTerminal(receipt.status) && receipt.status !== "pending" ? (
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted motion-reduce:animate-none" aria-hidden />
      ) : null}
    </span>
  );
}
