export type ProcessSignal = (pid: number, signal: NodeJS.Signals) => void;

export interface DetachedProcess {
  pid?: number;
  kill(signal?: NodeJS.Signals): boolean;
}

/** Signals an existing process group without falling through to a recycled leader pid. */
export function signalProcessGroup(
  pid: number | undefined,
  signal: NodeJS.Signals,
  signalProcess: ProcessSignal = process.kill,
): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    signalProcess(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

/** Signals a detached child's process group and falls back to its leader. */
export function signalDetachedProcessGroup(
  child: DetachedProcess,
  signal: NodeJS.Signals,
  signalProcess: ProcessSignal = process.kill,
): boolean {
  if (signalProcessGroup(child.pid, signal, signalProcess)) return true;
  try {
    return child.kill(signal);
  } catch {
    return false;
  }
}
