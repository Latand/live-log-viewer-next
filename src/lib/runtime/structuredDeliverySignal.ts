let kick: (() => void) | null = null;

export function setStructuredDeliveryKick(next: (() => void) | null): void {
  kick = next;
}

export function kickStructuredDeliveryQueue(): void {
  kick?.();
}
