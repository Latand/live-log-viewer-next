import type { LaunchDraftStorage } from "@/components/draft/AgentLaunchControls";

/*
 * Where a phone keeps an orchestrator draft between mounts.
 *
 * The keys are BYTE-IDENTICAL to the desktop panel's (`OrchestratorPanel`), and
 * deliberately so: the mandate, the launch parameters and — the one that
 * matters — the idempotency key of an unsettled confirm are properties of the
 * PROJECT'S draft, not of the surface that happens to be showing it. A confirm
 * started in the dock and continued on the phone (or in a tab that was resized
 * across the mobile breakpoint mid-submit) must replay the same durable intent
 * rather than mint a second designation.
 *
 * Create and rotate keep SEPARATE drafts (issue #1347), exactly as the dock
 * does: they are different decisions about different orchestrators, and a
 * half-written rotation must never overwrite the create draft the operator
 * would need if the seat were vacated.
 */

/** The two designation flows a project can hold a draft for. */
export type SeatDraftFlow = "Draft" | "Rotate";

const storageKey = (flow: SeatDraftFlow, project: string, name: string) => `llvOrchestrator${flow}:${project}:${name}`;

export function readSeatFlowField(flow: SeatDraftFlow, project: string, name: string): string {
  if (typeof window === "undefined") return "";
  try {
    return window.sessionStorage.getItem(storageKey(flow, project, name)) ?? "";
  } catch {
    return "";
  }
}

export function writeSeatFlowField(flow: SeatDraftFlow, project: string, name: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    if (value) window.sessionStorage.setItem(storageKey(flow, project, name), value);
    else window.sessionStorage.removeItem(storageKey(flow, project, name));
  } catch {
    /* private mode */
  }
}

/** The create draft's own fields — the pre-#1347 API, unchanged. */
export const readSeatDraftField = (project: string, name: string): string => readSeatFlowField("Draft", project, name);
export const writeSeatDraftField = (project: string, name: string, value: string): void => writeSeatFlowField("Draft", project, name, value);

/** One flow's persistence, as the shared launch module's own storage seam. A
    caller that hands this to `useSeatConfirm` keeps ONE instance per mount
    (`useMemo`): the flow's submit callback depends on it. */
export function seatFlowStorage(flow: SeatDraftFlow, project: string): LaunchDraftStorage {
  return {
    read: (name) => readSeatFlowField(flow, project, name),
    write: (name, value) => writeSeatFlowField(flow, project, name, value),
  };
}
