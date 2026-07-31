"use client";

import { useMemo, useSyncExternalStore } from "react";

import { OVERVIEW_CONTEXT, OVERVIEW_SLICE, viewBus } from "@/hooks/viewPresenceBus";

import {
  captureSelectedContext,
  selectedContextPreview,
  type SelectedCardIdentity,
  type SelectedContextPreview,
  type SelectedContextRef,
} from "./selectedContext";

/**
 * The live read of the selected-card reference, from the same bus the board,
 * scheme and phone already report presence into (#844).
 *
 * Deliberately a plain function, not a hook: it is called AT THE SUBMISSION
 * INSTANT — inside the submit handler, inside the voice send — so the reference
 * is decided by the state that existed when the operator acted, not by whatever
 * a render happened to close over. Everything the bus can say is read here in
 * one synchronous pass, which is what makes "change the selection right after
 * sending" leave the admitted turn alone.
 *
 * For rendering the badge BEFORE submission there is a subscribing hook (see
 * `useViewerSelectedContext`), because that surface does want to follow the
 * selection as it moves.
 */
export function viewerSelectedContext(now: number = Date.now()): SelectedContextRef {
  return captureSelectedContext({
    context: viewBus.getContext(),
    slice: viewBus.getSlice(),
    cards: viewBus.getCards(),
    identity: viewBus.getIdentity(),
    revision: viewBus.getSelectionRevision(),
    now,
  });
}

const NO_CARDS: readonly SelectedCardIdentity[] = [];

/**
 * The subscribing read, for the composer badge.
 *
 * Follows the selection as the operator moves it, which is exactly what the
 * capture path must NOT do — hence two entry points over one bus rather than one
 * shared value. The badge is a preview of what the next submission will carry;
 * `viewerSelectedContext()` is what that submission actually carries.
 *
 * Returns the time-free PREVIEW, not a reference: nothing has been captured yet,
 * and stamping a capture time on a badge the operator is still looking at would
 * make the preview claim something the submission has not done. Every input is
 * subscribed to individually and memoized over exactly those, and the bus hands
 * back the same object until something is reported — so a camera settle or a
 * scroll recomputes nothing.
 */
export function useViewerSelectedContext(): SelectedContextPreview {
  const context = useSyncExternalStore(viewBus.subscribe, viewBus.getContext, () => OVERVIEW_CONTEXT);
  const slice = useSyncExternalStore(viewBus.subscribe, viewBus.getSlice, () => OVERVIEW_SLICE);
  const cards = useSyncExternalStore(viewBus.subscribe, viewBus.getCards, () => NO_CARDS);
  return useMemo(() => selectedContextPreview({ context, slice, cards }), [context, slice, cards]);
}
