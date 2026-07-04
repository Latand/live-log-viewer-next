import type { FileEntry } from "@/lib/types";

import { isAwaitingUser } from "@/hooks/useSwitchboardData";

import { isChildConversation } from "./projectModel";

/**
 * Interactive lifecycle of a conversation pane, one notch finer than the
 * raw `activity`:
 *  - live      — mid-turn right now;
 *  - returned  — a child conversation came home with its result, worth reading;
 *  - waiting   — finished the turn, the next move is the user's;
 *  - stalled   — interrupted or holding on a permission prompt;
 *  - done      — finished with nothing pending: gray, a removal candidate.
 */
export type PaneState = "live" | "waiting" | "returned" | "stalled" | "done";

export function paneState(file: FileEntry, now = Date.now() / 1000): PaneState {
  if (file.pendingQuestion || file.waitingInput) return "waiting";
  if (file.activity === "live") return "live";
  if (file.activity === "recent" && isChildConversation(file) && file.proc !== "running") return "returned";
  if (isAwaitingUser(file, now)) return file.activity === "stalled" ? "stalled" : "waiting";
  return "done";
}
