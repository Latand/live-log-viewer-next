/* Startup adoption and route handlers can run in separate Next bundle realms.
   The Node process object carries the kick across those realm boundaries. */
const signalStore = process as typeof process & {
  __llvStructuredDeliveryKick?: (() => void | Promise<void>) | null;
};

export function setStructuredDeliveryKick(next: (() => void | Promise<void>) | null): void {
  signalStore.__llvStructuredDeliveryKick = next;
}

export function kickStructuredDeliveryQueue(): void | Promise<void> {
  return signalStore.__llvStructuredDeliveryKick?.();
}
