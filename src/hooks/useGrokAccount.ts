"use client";

import { useEffect, useState } from "react";

export type GrokAccountState = {
  signedIn: boolean | null;
  source: "session" | "api_key" | null;
};

const POLL_MS = 60_000;

export function useGrokAccount(): GrokAccountState {
  const [state, setState] = useState<GrokAccountState>({ signedIn: null, source: null });

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const response = await fetch("/api/grok/status");
        const json = await response.json() as {
          grok?: { signedIn?: boolean; source?: "session" | "api_key" | null };
        };
        if (!active) return;
        setState({
          signedIn: json.grok?.signedIn === true,
          source: json.grok?.source === "session" || json.grok?.source === "api_key" ? json.grok.source : null,
        });
      } catch {
        if (active) setState({ signedIn: false, source: null });
      }
    };
    void load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  return state;
}
