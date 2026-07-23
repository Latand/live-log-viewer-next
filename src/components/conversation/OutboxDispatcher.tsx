"use client";

import { useEffect, useLayoutEffect, useRef } from "react";

import { nextDispatch, type OutboxEntry } from "./outbox";

/**
 * The serial drain of one conversation's outbox (issue #561).
 *
 * Renders nothing. It exists as a component so the queue-first dispatch loop
 * can hold hooks while the composer's own delivery closure — which is defined
 * below several capability early-returns — stays exactly where it is.
 *
 * Serial by construction: `nextDispatch` yields nothing while an entry is
 * already on the wire, so the composer's idempotent one-attempt-at-a-time
 * delivery contract is untouched no matter how fast the operator submits.
 */
export function OutboxDispatcher({
  entries,
  ready,
  onDispatch,
}: {
  entries: readonly OutboxEntry[];
  /** False while the composer cannot start a delivery (busy, dictating, or
      reconciling an uncertain admission). The queue simply waits. */
  ready: boolean;
  onDispatch: (entry: OutboxEntry) => void;
}) {
  const next = ready ? nextDispatch(entries) : null;
  const nextId = next?.id ?? null;
  /* Latest props read back inside the effect. Written in a layout effect (never
     during render) so the dispatch keyed on `nextId` sees the current entry and
     callback without re-firing on every poll that leaves the head unchanged. */
  const latest = useRef<{ next: OutboxEntry | null; onDispatch: (entry: OutboxEntry) => void }>({ next, onDispatch });
  useLayoutEffect(() => {
    latest.current = { next, onDispatch };
  });
  useEffect(() => {
    const entry = latest.current.next;
    if (!entry) return;
    latest.current.onDispatch(entry);
  }, [nextId]);
  return null;
}
