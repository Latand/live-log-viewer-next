"use client";

import { useEffect, useState } from "react";

import { subscribeHostTarget, type HostTargetResult } from "./hostTargetBus";

/**
 * Resolves the host currently behind a conversation through the shared target
 * bus — usually a structured host, or the legacy pane its `pid` runs in (#1301).
 */
export function useHostTarget(pid: number | null, path?: string, enabled = true): string | null {
  const [target, setTarget] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || (pid === null && !path)) return;
    const unsubscribe = subscribeHostTarget({
      pid,
      path: path ?? "",
      onTarget(result: HostTargetResult) {
        if (typeof result === "object" && result !== null && "transportError" in result) return;
        setTarget(result);
      },
    });
    return unsubscribe;
  }, [pid, path, enabled]);

  return pid === null && !path ? null : target;
}
