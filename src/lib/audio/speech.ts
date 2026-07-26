"use client";

import type { CodexRealtimeLine } from "@/lib/realtime/codexRealtimeClient";

import type { Speaker } from "./ambientLoop";

/**
 * Who is speaking, read from the realtime transcript the call already produces.
 *
 * The wire says this and nothing else needs to: `input_transcript.added` and
 * `output_transcript.added` arrive as non-final lines while somebody is talking
 * and are marked final when they stop, which the client already folds into
 * `snapshot.lines`. Deriving speech from that costs no new signal, no analyser
 * node on either stream, and no second event path to keep in step.
 *
 * `progress` lines are the delegated worker's commentary being handed into the
 * call — text, not a participant's voice — so they never count as speech.
 */
export function speakingFromLines(lines: readonly CodexRealtimeLine[]): Speaker | null {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line || line.role === "progress") continue;
    if (line.final) return null;
    return line.role === "user" ? "operator" : "agent";
  }
  return null;
}
