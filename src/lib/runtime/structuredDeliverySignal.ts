let kick: (() => void | Promise<void>) | null = null;

export function setStructuredDeliveryKick(next: (() => void | Promise<void>) | null): void {
  kick = next;
}

export function kickStructuredDeliveryQueue(): void | Promise<void> {
  return kick?.();
}
