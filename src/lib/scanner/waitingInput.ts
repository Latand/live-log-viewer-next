import { paneScreen, resolveTarget, screenTail, WAITING_INPUT_PROMPTS } from "@/lib/tmux";

import type { FileEntry, WaitingInput } from "../types";

const QUIET_SECONDS = 15;
const STABLE_MS = 15_000;
const PROBE_TTL_MS = 10 * 60_000;

interface ProbeState {
  screen: string;
  at: number;
  since: number;
}

const probes = new Map<string, ProbeState>();

function looksPromptLike(screen: string): boolean {
  const tail = screen.split("\n").slice(-12).join("\n");
  return WAITING_INPUT_PROMPTS.some((pattern) => pattern.test(tail));
}

export async function waitingInputFor(entry: FileEntry): Promise<WaitingInput | null> {
  const now = Date.now();
  for (const [key, value] of probes) {
    if (now - value.at > PROBE_TTL_MS) probes.delete(key);
  }
  if (entry.proc !== "running" || entry.pid === null || entry.pendingQuestion) {
    probes.delete(entry.path);
    return null;
  }
  if (Date.now() / 1000 - entry.mtime < QUIET_SECONDS) return null;
  const target = await resolveTarget(entry.pid);
  if (target === null) return null;
  const screen = await paneScreen(target);
  if (!looksPromptLike(screen)) {
    probes.delete(entry.path);
    return null;
  }
  const previous = probes.get(entry.path);
  if (!previous || previous.screen !== screen) {
    probes.set(entry.path, { screen, at: now, since: now / 1000 });
    return null;
  }
  probes.set(entry.path, { ...previous, at: now });
  if (now / 1000 - previous.since < STABLE_MS / 1000) return null;
  return { since: previous.since, screenTail: screenTail(screen), target };
}
