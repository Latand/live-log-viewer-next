import type { FileEntry } from "@/lib/types";

export interface DeletionSafetyDependencies {
  list: (pin: string) => Promise<FileEntry[]>;
  ownerPath: (target: string) => string | null;
  ownerExists: (ownerPath: string) => Promise<boolean>;
  processMayBeRunning: (entry: FileEntry) => boolean;
}

export async function ownerTranscriptMayExist(
  ownerPath: string,
  statFile: (pathname: string) => Promise<{ isFile(): boolean }>,
): Promise<boolean> {
  try {
    return (await statFile(ownerPath)).isFile();
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

export async function transcriptDeletionBlocker(
  target: string,
  dependencies: DeletionSafetyDependencies,
): Promise<string | null> {
  const entry = (await dependencies.list(target)).find((item) => item.path === target);
  if (!entry) return "agent activity could not be verified — refresh and try again";
  if (entry.proc === "running" || entry.activity === "live" || dependencies.processMayBeRunning(entry)) {
    return "agent is still running — stop the process first";
  }
  const ownerPath = dependencies.ownerPath(target);
  if (!ownerPath || !(await dependencies.ownerExists(ownerPath))) return null;
  const owner = (await dependencies.list(ownerPath)).find((item) => item.path === ownerPath);
  return !owner || owner.proc === "running" || owner.activity === "live" || dependencies.processMayBeRunning(owner)
    ? "owning agent is still running — stop the process first"
    : null;
}
