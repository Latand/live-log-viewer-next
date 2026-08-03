"use client";

import { useSyncExternalStore } from "react";

import { MOBILE_LAYOUT_QUERY } from "@/lib/attention/eligibility";

/* Shared with attention-handoff selection: a window this narrow disables the
   attention host, so the selection predicate must count it out by the SAME
   number — see `@/lib/attention/eligibility`. */
const QUERY = MOBILE_LAYOUT_QUERY;

function subscribe(onChange: () => void) {
  const mq = window.matchMedia(QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

/** Phone-width viewport: the shell swaps the rail for a drawer and the scheme
    for the single-conversation focus layout. Server render assumes desktop. */
export function useIsMobile(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => false,
  );
}
