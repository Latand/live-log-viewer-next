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
 */

const storageKey = (project: string, name: string) => `llvOrchestratorDraft:${project}:${name}`;

export function readSeatDraftField(project: string, name: string): string {
  if (typeof window === "undefined") return "";
  try {
    return window.sessionStorage.getItem(storageKey(project, name)) ?? "";
  } catch {
    return "";
  }
}

export function writeSeatDraftField(project: string, name: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    if (value) window.sessionStorage.setItem(storageKey(project, name), value);
    else window.sessionStorage.removeItem(storageKey(project, name));
  } catch {
    /* private mode */
  }
}
