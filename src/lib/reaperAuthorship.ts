import fs from "node:fs";

import { statePath } from "@/lib/configDir";

/** The reaper's persisted state file (see reaperRuntime.ts). We read only the
    sticky authorship map — the rest of the shape is irrelevant here. */
const STATE_FILE = () => statePath("reaper-state.json");

/**
 * Human-authorship evidence recorded by the reaper (PR #125). The reaper scans
 * live transcripts for a real user message — filtering Claude task-notification
 * records and viewer-injected relays — and persists every path it confirms to a
 * sticky `userAuthoredPaths` map that survives restarts. The board reads that
 * map (rather than re-scanning every transcript on the hot files poll) to pin
 * owner-touched cards against worker-class auto-collapse (issue #112).
 *
 * The reaper's viewer-aware count is the RIGHT source here, not a raw
 * transcript scan: a headless reviewer is spawned with an engine prompt and a
 * flow implementer receives viewer-relayed findings as user-role records, so a
 * naive "has a user message" scan would mark both as owner-touched and defeat
 * the very collapse this feature exists for. The reaper discounts those
 * viewer/spawn-injected messages (its message allowance) and only records a
 * path once a genuine human message clears it — exactly the pin we want.
 *
 * Missing/corrupt state is treated as "no evidence yet". `observedAtSec` is the
 * wall time of the reaper's last cycle (the state file's mtime — `runReaperCycle`
 * rewrites it every pass), or null when the reaper has never run. The board
 * fails CLOSED against it: a worker is only collapse-eligible when the reaper
 * has scanned it AFTER its latest activity, so a transcript that changed since
 * the last cycle (a fresh owner message, a cold start) is never collapsed on
 * unverified authorship — the hard exemption holds even in the persistence gap.
 */
export interface AuthorshipEvidence {
  userAuthoredPaths: Set<string>;
  observedAtSec: number | null;
}

export function readAuthorshipEvidence(): AuthorshipEvidence {
  const file = STATE_FILE();
  let observedAtSec: number | null = null;
  try {
    observedAtSec = fs.statSync(file).mtimeMs / 1000;
  } catch {
    return { userAuthoredPaths: new Set(), observedAtSec: null };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { userAuthoredPaths?: unknown };
    const map = parsed.userAuthoredPaths;
    if (!map || typeof map !== "object" || Array.isArray(map)) return { userAuthoredPaths: new Set(), observedAtSec };
    return { userAuthoredPaths: new Set(Object.keys(map as Record<string, unknown>)), observedAtSec };
  } catch {
    return { userAuthoredPaths: new Set(), observedAtSec };
  }
}

/** Back-compat convenience: just the confirmed-authorship path set. */
export function readUserAuthoredPaths(): Set<string> {
  return readAuthorshipEvidence().userAuthoredPaths;
}
