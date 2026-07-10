"use client";

import { createContext, useContext } from "react";

/** Resolves the raw source line at an absolute stream index, or null when it
    has slid out of the retained window. Provided by LogFeed, consumed by a
    tool card's level-2 "raw record" affordance for lazy, client-side detail —
    no server round-trip (issue #9 §6). */
export type RawLineLookup = (src: number) => string | null;

const RawLineContext = createContext<RawLineLookup>(() => null);

export const RawLineProvider = RawLineContext.Provider;

export function useRawLine(): RawLineLookup {
  return useContext(RawLineContext);
}
