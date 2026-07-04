import { linuxBackend } from "./linux";
import { portableBackend } from "./portable";
import type { ProcBackend } from "./types";

export type { ProcBackend, ProcSnapshotEntry } from "./types";

/**
 * Backend selection: Linux reads `/proc` directly; everything else (macOS)
 * shells out to `ps`/`lsof`. `VIEWER_PROC_BACKEND=portable` forces the
 * portable path on Linux too, so it can be exercised and parity-tested on a
 * machine that also has the fast native backend to compare against.
 */
function selectBackend(): ProcBackend {
  const override = process.env.VIEWER_PROC_BACKEND;
  if (override === "portable") return portableBackend;
  if (override === "linux") return linuxBackend;
  return process.platform === "linux" ? linuxBackend : portableBackend;
}

export const procBackend: ProcBackend = selectBackend();
