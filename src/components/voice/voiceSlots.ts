"use client";

import type { FileEntry } from "@/lib/types";

/**
 * Where the one voice rendering goes, per conversation (#691 follow-up).
 *
 * `VoicePipHost` is the sole renderer of the voice conversation panel, and
 * `VoiceComposerHost` is the sole owner of a conversation card's composer
 * machinery. Neither may render a second copy for another containment, so places
 * are published as DOM nodes instead:
 *
 * - the CARD publishes its dock slot — the spot above its composer where the panel
 *   renders while no floating window is open;
 * - the PIP HOST publishes its composer slot — the spot under the panel in the
 *   floating window where the one `ComposerBar` moves while it is open;
 * - the CARD publishes its composer slot and props — the spot where the hoisted
 *   composer (draft, dictation, attachments and their object URLs, outbox, send
 *   machinery) renders while the card is on screen. The composer itself is OWNED
 *   at Viewer level, which is the whole point: the card unmounting mid-call must
 *   not tear down a recording or revoke a staged image's object URL.
 *
 * Shaped like `activeCall.ts`: a module-scoped observable map, no React state, no
 * ownership of what gets rendered. A slot is a place, not a rendering.
 */

const dockSlots = new Map<string, HTMLElement>();
const composerSlots = new Map<string, HTMLElement>();
const listeners = new Set<() => void>();

/** Monotonic change marker: `useSyncExternalStore` consumers that read several
    maps at once subscribe to this one value instead of caching snapshots. */
let version = 0;

function notify(): void {
  version += 1;
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

/* ------------------------------------------------------------------------- *
 * The hoisted composer's seam: card places and props, and the host's presence.
 * ------------------------------------------------------------------------- */

/** What the card knows that the hoisted composer needs. Republished on every card
    render, because `file` is a fresh snapshot each board poll; retained after the
    card unmounts so a mid-call composer keeps working with the last-known view. */
export interface VoiceComposerCardProps {
  file: FileEntry;
  pollPaused: boolean;
  deadHost: boolean;
  sendBlockedReason: string | null;
  placeholder?: string;
}

/**
 * Places for one conversation's hoisted composer, oldest first.
 *
 * There is exactly ONE composer per conversation, so when several surfaces are
 * on screen for the same conversation at once — the board card under the
 * full-window overlay, the board card beside the orchestrator dock (#977) —
 * they are competing PLACES for it, not competing composers. Keeping the whole
 * stack instead of the newest node alone is what makes that survivable: the
 * newest place renders the form, and when it retracts the composer falls back
 * to the place underneath instead of having nowhere to go.
 *
 * `primary` is the explicit override for a surface that is the operator's
 * conversation window rather than an incidental card of it: it outranks the
 * stack order, so a board card mounting or remounting later cannot take the
 * form out of the dock the operator is typing in.
 */
interface ComposerPlace {
  node: HTMLElement;
  primary: boolean;
}

const composerCardNodes = new Map<string, ComposerPlace[]>();
const composerCardProps = new Map<string, VoiceComposerCardProps>();

/** How many `VoiceComposerHost`s are mounted (production: exactly one).
    Cards defer their composer to the host ONLY while a host exists, so an
    isolated tree — a component test, the demo renderer — that mounts no host
    keeps the inline card-scoped composer it always had. */
let composerHosts = 0;

/** A surface's place for the hoisted composer. Returns the retraction. */
export function publishVoiceComposerCardNode(cardId: string, node: HTMLElement, primary = false): () => void {
  const place: ComposerPlace = { node, primary };
  composerCardNodes.set(cardId, [...(composerCardNodes.get(cardId) ?? []), place]);
  notify();
  return () => {
    const places = composerCardNodes.get(cardId);
    if (!places) return;
    const remaining = places.filter((entry) => entry !== place);
    if (remaining.length === places.length) return;
    if (remaining.length) composerCardNodes.set(cardId, remaining);
    else composerCardNodes.delete(cardId);
    notify();
  };
}

/** The card's latest props for the hoisted composer. Kept after the card goes:
    the composer of an active call outlives its card and needs SOMETHING to render
    with; stale runtime detail refreshes through the composer's own hooks. Released
    by `forgetVoiceComposerCardProps` once no composer renders from them. */
export function publishVoiceComposerCardProps(cardId: string, props: VoiceComposerCardProps): void {
  const current = composerCardProps.get(cardId);
  if (current
    && current.file === props.file
    && current.pollPaused === props.pollPaused
    && current.deadHost === props.deadHost
    && current.sendBlockedReason === props.sendBlockedReason
    && current.placeholder === props.placeholder) {
    return;
  }
  composerCardProps.set(cardId, props);
  notify();
}

/**
 * Drop a retained props snapshot.
 *
 * The retraction of a card's NODE cannot do this: the whole point of retaining
 * props is that they outlive the card while its composer is parked mid-call. So
 * the release is the composer owner's call — `VoiceComposerHost` forgets a
 * conversation once it renders no composer for it — and without that release the
 * map keeps one `FileEntry` snapshot per conversation ever rendered, for the life
 * of the tab.
 */
export function forgetVoiceComposerCardProps(cardId: string): void {
  if (!composerCardProps.delete(cardId)) return;
  notify();
}

export function getVoiceComposerCardIds(): readonly string[] {
  return [...composerCardNodes.keys()];
}

/** Which conversations still hold a retained props snapshot. */
export function getVoiceComposerCardPropsIds(): readonly string[] {
  return [...composerCardProps.keys()];
}

/** Where this conversation's one composer renders: the newest primary place if
    any surface claimed that rank, else the newest place published. */
export function getVoiceComposerCardNode(cardId: string): HTMLElement | null {
  const places = composerCardNodes.get(cardId);
  if (!places?.length) return null;
  return (places.findLast((place) => place.primary) ?? places[places.length - 1]!).node;
}

export function getVoiceComposerCardProps(cardId: string): VoiceComposerCardProps | null {
  return composerCardProps.get(cardId) ?? null;
}

/** Announced by `VoiceComposerHost` on mount. Returns the retraction. */
export function announceVoiceComposerHost(): () => void {
  composerHosts += 1;
  notify();
  return () => {
    composerHosts -= 1;
    notify();
  };
}

export function isVoiceComposerHostMounted(): boolean {
  return composerHosts > 0;
}

/** No host exists in the server render, so cards render inline there — which is
    also what the first client (hydration) render must match. */
export function getServerVoiceComposerHostMounted(): false {
  return false;
}

export function getVoiceSlotsVersion(): number {
  return version;
}

export function getServerVoiceSlotsVersion(): number {
  return 0;
}

/** Tests only. */
export function resetVoiceSlotsForTest(): void {
  dockSlots.clear();
  composerSlots.clear();
  composerCardNodes.clear();
  composerCardProps.clear();
  composerHosts = 0;
  listeners.clear();
}
