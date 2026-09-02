"use client";

import { Check } from "lucide-react";
import { useSyncExternalStore } from "react";

import { useLocale } from "@/lib/i18n";

/*
 * Receipts (docs/design/mobile-v2/README.md §2 rule 9, §5): no action on the
 * phone asks for confirmation; each acts on the tap that names it and answers
 * with a receipt in flow between the body and the dock — inside a sheet,
 * between its body and its footer — for four seconds, with the inverse action
 * as a 44 px text button when one exists: Kill → Respawn, Close → Reopen,
 * Archive → Restore, switch account → Switch back, Skip → Retry stage.
 *
 * The receipt takes its own height, so the scroller above it shrinks and no
 * control can sit beneath it (the capture's `receipt` gate refuses one that
 * covers a control). One store serves every surface; a new receipt replaces
 * the one showing and restarts the clock.
 */

export const RECEIPT_MS = 4_000;

export type ReceiptInverse = "respawn" | "reopen" | "restore" | "switchBack" | "retryStage";

export interface ReceiptAction {
  kind: ReceiptInverse;
  run: () => void;
}

export interface Receipt {
  id: number;
  text: string;
  inverse: ReceiptAction | null;
}

export interface ReceiptTimers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface ReceiptStore {
  getState(): Receipt | null;
  subscribe(listener: () => void): () => void;
  show(text: string, inverse?: ReceiptAction | null): Receipt;
  dismiss(): void;
  /** Run the inverse action and take the receipt down. */
  undo(): void;
}

const REAL_TIMERS: ReceiptTimers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createReceiptStore(timers: ReceiptTimers = REAL_TIMERS): ReceiptStore {
  let current: Receipt | null = null;
  let handle: unknown = null;
  let seq = 0;
  const listeners = new Set<() => void>();
  const set = (next: Receipt | null): void => {
    current = next;
    for (const listener of listeners) listener();
  };
  const dismiss = (): void => {
    if (handle !== null) timers.clear(handle);
    handle = null;
    if (current) set(null);
  };
  return {
    getState: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    show(text, inverse = null) {
      if (handle !== null) timers.clear(handle);
      seq += 1;
      const receipt: Receipt = { id: seq, text, inverse };
      handle = timers.set(() => {
        handle = null;
        if (current?.id === receipt.id) set(null);
      }, RECEIPT_MS);
      set(receipt);
      return receipt;
    },
    dismiss,
    undo() {
      const action = current?.inverse;
      dismiss();
      action?.run();
    },
  };
}

/** The tab's one receipt slot. */
export const receipts: ReceiptStore = createReceiptStore();

export function showReceipt(text: string, inverse?: ReceiptAction | null): Receipt {
  return receipts.show(text, inverse);
}

export function useReceipt(store: ReceiptStore = receipts): Receipt | null {
  return useSyncExternalStore(store.subscribe, store.getState, () => null);
}

const PLACEMENT = {
  /* Between the body and the dock: raised surface, success edge, shadow-2. */
  flow: "mx-3 my-1.5 shadow-[inset_3px_0_0_var(--color-success),var(--shadow-2)]",
  /* Inside a sheet, above its footer: the sheet already carries the shadow. */
  sheet: "mx-4 mt-1.5 shadow-[inset_3px_0_0_var(--color-success),0_0_0_1px_var(--border-default)]",
} as const;

export function MobileReceipt({ store = receipts, placement = "flow" }: { store?: ReceiptStore; placement?: keyof typeof PLACEMENT }) {
  const { t } = useLocale();
  const receipt = useReceipt(store);
  if (!receipt) return null;
  return (
    <div
      role="status"
      data-mobile2-receipt
      data-mobile2-receipt-placement={placement}
      className={`flex min-h-11 shrink-0 items-center gap-2 rounded-[12px] bg-raised pl-3 pr-1 text-ui font-semibold text-primary ${PLACEMENT[placement]}`}
    >
      <Check className="h-4 w-4 shrink-0 text-success" aria-hidden />
      <span className="min-w-0 flex-1">{receipt.text}</span>
      {receipt.inverse ? (
        <button
          type="button"
          data-mobile2-receipt-undo={receipt.inverse.kind}
          className="ml-auto inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-[8px] px-2.5 font-bold text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          onClick={() => store.undo()}
        >
          {t(`mobile2.receipt.${receipt.inverse.kind}`)}
        </button>
      ) : null}
    </div>
  );
}
