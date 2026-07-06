"use client";

import { useEffect, useState } from "react";

import { subscribeTmuxTarget, type TmuxBusResult } from "./tmuxBus";

/**
 * Resolves the tmux pane behind a conversation through the shared tmux target
 * bus: the pane its `pid` runs in, or the resume window previously spawned for
 * its transcript `path`.
 */
export function useTmuxTarget(pid: number | null, path?: string, enabled = true): string | null {
  const [target, setTarget] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || (pid === null && !path)) return;
    const unsubscribe = subscribeTmuxTarget({
      pid,
      path: path ?? "",
      onTarget(result: TmuxBusResult) {
        if (typeof result === "object" && result !== null && "transportError" in result) return;
        setTarget(result);
      },
    });
    return unsubscribe;
  }, [pid, path, enabled]);

  return pid === null && !path ? null : target;
}
