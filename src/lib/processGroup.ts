export type ProcessSignal = (pid: number, signal: NodeJS.Signals) => void;

export interface DetachedProcess {
  pid?: number;
  kill(signal?: NodeJS.Signals): boolean;
}

/** Signals a detached child's process group and falls back to its leader. */
export function signalDetachedProcessGroup(
  child: DetachedProcess,
  signal: NodeJS.Signals,
  signalProcess: ProcessSignal = process.kill,
): boolean {
  if (child.pid && Number.isInteger(child.pid) && child.pid > 0) {
    try {
      signalProcess(-child.pid, signal);
      return true;
    } catch {
      // The leader may have exited before its process group was reaped.
    }
  }
  try {
    return child.kill(signal);
  } catch {
    return false;
  }
}
