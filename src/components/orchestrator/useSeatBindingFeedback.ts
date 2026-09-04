"use client";

import { useEffect, useState } from "react";

import { SEAT_BIND_TIMEOUT_MS } from "./seatState";

/** Mobile observes binding only while the seat sheet is open. Each project,
 * seat and uninterrupted unresolved episode gets the full grace interval. */
export function useSeatBindingFeedback({
  project, conversationId, active, pending, hasReading, stale, refreshIncumbent,
}: {
  project: string;
  conversationId: string | null;
  active: boolean;
  pending: boolean;
  hasReading: boolean;
  stale: boolean;
  refreshIncumbent: () => Promise<void>;
}): number | null {
  const key = JSON.stringify([project, conversationId]);
  const waiting = active && pending;
  const [bounded, setBounded] = useState<string | null>(null);
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => setBounded(key), SEAT_BIND_TIMEOUT_MS);
    return () => {
      clearTimeout(timer);
      setBounded(null);
    };
  }, [waiting, key]);

  useEffect(() => {
    if (active) void refreshIncumbent();
  }, [active, key, refreshIncumbent]);

  // A retained reading that cannot bind asks once again on this edge, just as
  // desktop does. Failed reads then retry until fresh evidence answers.
  const unboundWithReading = waiting && hasReading;
  useEffect(() => {
    if (unboundWithReading) void refreshIncumbent();
  }, [unboundWithReading, key, refreshIncumbent]);
  const unboundWithoutFreshReading = waiting && stale;
  useEffect(() => {
    if (!unboundWithoutFreshReading) return;
    const timer = setInterval(() => void refreshIncumbent(), 2_000);
    return () => clearInterval(timer);
  }, [unboundWithoutFreshReading, key, refreshIncumbent]);

  return waiting && bounded === key ? SEAT_BIND_TIMEOUT_MS : null;
}
