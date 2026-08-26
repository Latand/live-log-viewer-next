import type { ResourceSession } from "@/lib/types";

/**
 * Who the resources dialog's bulk buttons may reach.
 *
 * Kept pure and apart from the dialog because these are promises, not styling:
 * "idle" has to mean the turn settled AND the transcript went quiet, and a live
 * orchestrator seat has to survive a clean-slate kill unless the operator
 * ticked it. The kill route enforces the seat rule again on its own side; this
 * is what the operator sees before clicking.
 */

/** A structured host row. A row with no kind is a legacy tmux pane. */
export function isStructuredHost(session: ResourceSession): boolean {
  return session.kind === "structured";
}

function killable(session: ResourceSession, ticked: ReadonlySet<string>): boolean {
  return session.seat !== true || ticked.has(session.target);
}

/**
 * Hosts idle longer than `hours`: the turn settled and the transcript has been
 * quiet that long. A row with no last-active time has no idle age to compare,
 * so "idle longer than N hours" is unprovable for it and it is left alone.
 */
export function idleKillTargets(
  sessions: readonly ResourceSession[],
  hours: number,
  nowSeconds: number,
  ticked: ReadonlySet<string>,
): ResourceSession[] {
  const cutoff = (nowSeconds - hours * 3_600) * 1_000;
  return sessions.filter((session) => killable(session, ticked)
    && session.activity !== "live"
    && session.turnBusy !== true
    && session.lastActiveAt !== null
    && Date.parse(session.lastActiveAt) < cutoff);
}

/** Every listed host, live ones included — the clean slate. */
export function bulkKillTargets(
  sessions: readonly ResourceSession[],
  ticked: ReadonlySet<string>,
): ResourceSession[] {
  return sessions.filter((session) => killable(session, ticked));
}

/** What the footer summarises: how many hosts, how many idle, and the resident
    memory they hold. Resident only — swap is the pressure the RAM/Swap rows
    above already report, and adding it here would overstate what killing these
    hosts gives back. */
export function resourceCounts(
  sessions: readonly ResourceSession[],
  hours: number,
  nowSeconds: number,
): { hosts: number; idle: number; bytes: number } {
  return {
    hosts: sessions.length,
    idle: idleKillTargets(sessions, hours, nowSeconds, new Set()).length,
    bytes: sessions.reduce((total, session) => total + session.rssBytes, 0),
  };
}
