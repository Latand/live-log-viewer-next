"use client";

import { createContext, useContext } from "react";

/**
 * The orchestrator seat behind the feed being rendered (#1166).
 *
 * The mandate card names which mandate it is standing in for, and the only
 * authority for that is the seat's own record: `promptVersion` is a number
 * when the mandate was the approved default of that version, and null when the
 * operator edited it. The dock mounts this around its feed because it already
 * reads the seat; a surface with no seat in scope — the board's conversation
 * pane — leaves it absent, and the card omits the qualifier instead of
 * guessing one from a transcript row.
 */
export interface MandateSeat {
  promptVersion?: number | null;
}

const NO_SEAT: MandateSeat = {};
const MandateSeatContext = createContext<MandateSeat>(NO_SEAT);

export const MandateSeatProvider = MandateSeatContext.Provider;

export function useMandateSeat(): MandateSeat {
  return useContext(MandateSeatContext);
}
