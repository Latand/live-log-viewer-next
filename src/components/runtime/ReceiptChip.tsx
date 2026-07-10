"use client";

import { useLocale, type TFunction } from "@/lib/i18n";

import { receiptIsTerminal, type ReceiptStatus, type RuntimeReceipt } from "./runtimeModel";

/** Tone per receipt status. Text carries the meaning; color only reinforces. */
function tone(status: ReceiptStatus): string {
  if (status === "rejected" || status === "failed") return "border-err/30 bg-err/10 text-err";
  if (status === "delivered" || status === "answered") return "border-ok/25 bg-ok/10 text-ok";
  if (status === "uncertain") return "border-[#e0ae45]/45 bg-[#fff5dc] text-[#8a5a00]";
  return "border-line bg-chip text-dim";
}

function statusText(t: TFunction, receipt: RuntimeReceipt): string {
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
export function ReceiptChip({ receipt, onRetry, onEdit }: ReceiptChipProps) {
  const { t } = useLocale();
  const failed = receipt.status === "rejected" || receipt.status === "failed";
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 text-[11px] font-semibold" data-operation={receipt.operationId}>
      <span
        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 ${tone(receipt.status)}`}
        data-receipt-status={receipt.status}
        {...(failed ? { role: "status", "aria-live": "polite" as const } : {})}
      >
        {statusText(t, receipt)}
      </span>
      {failed && onRetry ? (
        <button
          className="rounded-full border border-line bg-bg px-2 py-0.5 text-dim hover:border-accent/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          onClick={onRetry}
        >
          {t("runtime.receipt.retry")}
        </button>
      ) : null}
      {failed && onEdit ? (
        <button
          className="rounded-full border border-line bg-bg px-2 py-0.5 text-dim hover:border-accent/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          onClick={onEdit}
        >
          {t("runtime.receipt.edit")}
        </button>
      ) : null}
      {!receiptIsTerminal(receipt.status) && receipt.status !== "pending" ? (
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-dim motion-reduce:animate-none" aria-hidden />
      ) : null}
    </span>
  );
}
