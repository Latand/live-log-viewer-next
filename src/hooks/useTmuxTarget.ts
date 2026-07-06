"use client";

import { useEffect, useState } from "react";

const POLL_MS = 5_000;

/**
 * Polls /api/tmux for the tmux pane behind a conversation: the pane its `pid`
 * runs in, or — for a finished conversation — the resume window previously
 * spawned for its transcript `path`. Returns the `session:window.pane` target
 * string, or null when neither yields a live pane.
 */
export function useTmuxTarget(pid: number | null, path?: string, enabled = true): string | null {
  const [target, setTarget] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || (pid === null && !path)) return;
    let alive = true;
    const load = async () => {
      try {
        const query = new URLSearchParams();
        if (pid !== null) query.set("pid", String(pid));
        if (path) query.set("path", path);
        const res = await fetch(`/api/tmux?${query.toString()}`);
        if (!res.ok) return;
        const body = (await res.json()) as { target?: string | null };
        if (alive) setTarget(body.target ?? null);
      } catch {
        /* keep previous target */
      }
    };
    void load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [pid, path, enabled]);

  return pid === null && !path ? null : target;
}
