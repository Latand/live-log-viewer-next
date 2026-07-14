/* The kick is registered by startup adoption (instrumentation bundle) and
   fired from route handlers (their own bundle), so it must live on
   `globalThis` — module-level state does not cross Next standalone bundles. */
const signalStore = globalThis as typeof globalThis & {
  __llvStructuredDeliveryKick?: (() => void | Promise<void>) | null;
};

export function setStructuredDeliveryKick(next: (() => void | Promise<void>) | null): void {
  signalStore.__llvStructuredDeliveryKick = next;
}

export function kickStructuredDeliveryQueue(): void | Promise<void> {
  return signalStore.__llvStructuredDeliveryKick?.();
}
