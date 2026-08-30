import { linuxBackend } from "./linux";
import { portableBackend } from "./portable";
import type { ProcBackend } from "./types";
import { windowsBackend } from "./windows";

export type { ProcBackend, ProcSnapshotEntry } from "./types";

/**
 * Backend selection: Linux reads `/proc` directly, Windows reads a
 * `Win32_Process` snapshot, and everything else (macOS) shells out to
 * `ps`/`lsof`. The `VIEWER_PROC_BACKEND` override forces one of the three, so
 * a backend can be exercised and parity-tested on a machine that also has the
 * fast native one to compare against. Forcing `portable` on win32 is a way to
 * get an empty scan and nothing else — `ps` and `lsof` are not there — but the
 * override is deliberately literal rather than clever about it.
 */
export function selectProcBackend(
  platform: NodeJS.Platform = process.platform,
  override: string | undefined = process.env.VIEWER_PROC_BACKEND,
): ProcBackend {
  if (override === "portable") return portableBackend;
  if (override === "linux") return linuxBackend;
  if (override === "windows") return windowsBackend;
  if (platform === "linux") return linuxBackend;
  return platform === "win32" ? windowsBackend : portableBackend;
}

export const procBackend: ProcBackend = selectProcBackend();
