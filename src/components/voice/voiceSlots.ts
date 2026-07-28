"use client";

/**
 * Where the one voice rendering goes, per conversation (#691 follow-up).
 *
 * `VoicePipHost` is the sole renderer of the voice conversation panel, and the card
 * is the sole owner of the composer. Neither may render a second copy for the other
 * containment, so each publishes a DOM node instead:
 *
 * - the CARD publishes its dock slot — the spot above its composer where the panel
 *   renders while no floating window is open;
 * - the HOST publishes its PiP composer slot — the spot under the panel in the
 *   floating window where the card portals its one `ComposerBar` while it is open.
 *
 * Shaped like `activeCall.ts`: a module-scoped observable map, no React state, no
 * ownership of what gets rendered. A slot is a place, not a rendering.
 */

const dockSlots = new Map<string, HTMLElement>();
const composerSlots = new Map<string, HTMLElement>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function publish(slots: Map<string, HTMLElement>, conversationId: string, node: HTMLElement): () => void {
  slots.set(conversationId, node);
  notify();
  return () => {
    /* Retract only what is still current: a remount publishes its new node before
       the outgoing one cleans up, and the replacement must survive that ordering. */
    if (slots.get(conversationId) !== node) return;
    slots.delete(conversationId);
    notify();
  };
}

/** The card's dock slot. Returns the retraction, for use as a ref cleanup. */
export function publishVoiceDockSlot(conversationId: string, node: HTMLElement): () => void {
  return publish(dockSlots, conversationId, node);
}

/** The host's PiP composer slot. Returns the retraction, for use as a ref cleanup. */
export function publishVoiceComposerSlot(conversationId: string, node: HTMLElement): () => void {
  return publish(composerSlots, conversationId, node);
}

export function getVoiceDockSlot(conversationId: string | null): HTMLElement | null {
  return conversationId ? dockSlots.get(conversationId) ?? null : null;
}

export function getVoiceComposerSlot(conversationId: string | null): HTMLElement | null {
  return conversationId ? composerSlots.get(conversationId) ?? null : null;
}

export function subscribeVoiceSlots(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The server render has no DOM nodes to publish or portal into. */
export function getServerVoiceSlot(): null {
  return null;
}

/** Tests only. */
export function resetVoiceSlotsForTest(): void {
  dockSlots.clear();
  composerSlots.clear();
  listeners.clear();
}
