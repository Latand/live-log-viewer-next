/** A notification only: the existing seat tick controller owns all scheduling. */
export interface SeatTickSignal {
  project?: string | null;
  conversationId?: string;
  boundary?: { generation: string; turnId: string; seq: number; state: "busy" | "settled"; at: string };
}
const signals = process as typeof process & { __llvSeatTickKick?: ((signal: SeatTickSignal) => void) | null };
export function registerSeatTickKick(callback: ((signal: SeatTickSignal) => void) | null): void {
  signals.__llvSeatTickKick = callback;
}
export function requestSeatTick(signal: SeatTickSignal): void {
  try { signals.__llvSeatTickKick?.(signal); }
  catch (error) { console.error("[seat tick] notification failed", error instanceof Error ? error.name : "unknown"); }
}
