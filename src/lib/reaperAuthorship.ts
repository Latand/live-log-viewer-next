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
 * Missing/corrupt state is treated as "no evidence yet". `scannedAt` is the
 * PATH-SCOPED freshness map: for each transcript the reaper scanned to
 * completion and cleared, the transcript mtime (seconds) it observed. The board
 * fails CLOSED against it: a claude/codex worker is only collapse-eligible when
 * `scannedAt[path]` is at least as fresh as the file's current mtime — the
 * reaper actually looked at this exact content. A path the reaper never scanned
 * (a worker that exited before any cycle reached it) has no stamp and stays
 * pinned, so an unobserved user-authored transcript can never collapse. A single
 * global "last cycle" timestamp could not express this: it advances every cycle
 * regardless of which paths were scanned, and would certify the unscanned.
 *
 * `observedAtSec` (the state file's mtime, or null before the reaper's first
 * run) is retained only as a coarse "has the reaper ever run" signal.
 */
export interface AuthorshipEvidence {
  userAuthoredPaths: Set<string>;
  scannedAt: Map<string, number>;
  observedAtSec: number | null;
}

export function readAuthorshipEvidence(): AuthorshipEvidence {
  const file = STATE_FILE();
  let observedAtSec: number | null = null;
  try {
    observedAtSec = fs.statSync(file).mtimeMs / 1000;
  } catch {
    return { userAuthoredPaths: new Set(), scannedAt: new Map(), observedAtSec: null };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { userAuthoredPaths?: unknown; scannedAt?: unknown };
    const authored = parsed.userAuthoredPaths;
    const userAuthoredPaths = authored && typeof authored === "object" && !Array.isArray(authored)
      ? new Set(Object.keys(authored as Record<string, unknown>))
      : new Set<string>();
    const scannedAt = new Map<string, number>();
    const rawScanned = parsed.scannedAt;
    if (rawScanned && typeof rawScanned === "object" && !Array.isArray(rawScanned)) {
      for (const [pathname, value] of Object.entries(rawScanned as Record<string, unknown>)) {
        if (typeof value === "number" && Number.isFinite(value)) scannedAt.set(pathname, value);
      }
    }
    return { userAuthoredPaths, scannedAt, observedAtSec };
  } catch {
    return { userAuthoredPaths: new Set(), scannedAt: new Map(), observedAtSec };
  }
}

/** Back-compat convenience: just the confirmed-authorship path set. */
export function readUserAuthoredPaths(): Set<string> {
  return readAuthorshipEvidence().userAuthoredPaths;
}
