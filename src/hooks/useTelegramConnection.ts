"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { NONTERMINAL_TELEGRAM_LOGIN_PHASES, type TelegramStatusPayload } from "@/lib/telegram/contracts";

/**
 * Client state for the Telegram connection row/panel (issue #1059). Mirrors
 * the account hooks' shape: one status payload, one busy flag, thin actions
 * that re-sync from the server's returned payload. Polling is phase-aware —
 * fast only while a login operation is live, slow otherwise — so the footer
 * dot stays truthful without hammering the API.
 */

const IDLE_POLL_MS = 60_000;
const LOGIN_POLL_MS = 1_500;

/** Why the last action did not produce a payload: the server's sanitized
    error code (`login_busy`, `action_failed`, …) or `"transport"` when the
    request itself failed. Cleared by the next action or successful poll of a
    changed phase — durable server-side errors ride in `status.error`. */
export type TelegramActionFailure = { code: string };

export type TelegramConnectionState = {
  status: TelegramStatusPayload | null;
  busy: boolean;
  failure: TelegramActionFailure | null;
  refresh(fresh?: boolean): Promise<void>;
  connect(): Promise<void>;
  submitPassword(password: string): Promise<void>;
  cancel(): Promise<void>;
  logout(): Promise<void>;
  deleteLocal(): Promise<void>;
};

type ActionOutcome =
  | { payload: TelegramStatusPayload }
  | { payload: null; code: string };

async function readOutcome(response: Response): Promise<ActionOutcome> {
  const json = await response.json().catch(() => null) as { telegram?: TelegramStatusPayload; code?: unknown } | null;
  if (response.ok && json?.telegram) return { payload: json.telegram };
  const code = typeof json?.code === "string" && /^[a-z_]{1,40}$/.test(json.code) ? json.code : "action_failed";
  return { payload: null, code };
}

export function useTelegramConnection(): TelegramConnectionState {
  const [status, setStatus] = useState<TelegramStatusPayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<TelegramActionFailure | null>(null);
  /* Latest payload for event handlers and the poll loop; written only where
     a payload actually arrives, never during render. */
  const statusRef = useRef<TelegramStatusPayload | null>(null);

  const apply = useCallback((payload: TelegramStatusPayload) => {
    statusRef.current = payload;
    setStatus(payload);
  }, []);

  const load = useCallback(async (fresh: boolean): Promise<TelegramStatusPayload | null> => {
    try {
      const outcome = await readOutcome(await fetch(`/api/telegram${fresh ? "?fresh=1" : ""}`));
      if (outcome.payload) apply(outcome.payload);
      return outcome.payload;
    } catch {
      /* A failed poll keeps the last known status. */
      return null;
    }
  }, [apply]);

  const refresh = useCallback(async (fresh = false) => {
    await load(fresh);
  }, [load]);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      const payload = (await load(false)) ?? statusRef.current;
      if (disposed) return;
      const live = payload?.login != null && NONTERMINAL_TELEGRAM_LOGIN_PHASES.has(payload.phase);
      timer = setTimeout(() => void tick(), live ? LOGIN_POLL_MS : IDLE_POLL_MS);
    };
    void tick();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, [load]);

  const act = useCallback(async (body: Record<string, string>) => {
    setBusy(true);
    setFailure(null);
    try {
      const response = await fetch("/api/telegram", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const outcome = await readOutcome(response);
      if (outcome.payload) apply(outcome.payload);
      else {
        /* The backend's sanitized code survives to the panel, and the status
           re-syncs so the phase on screen stays the server's. */
        setFailure({ code: outcome.code });
        await refresh();
      }
    } catch {
      setFailure({ code: "transport" });
    } finally {
      setBusy(false);
    }
  }, [apply, refresh]);

  const connect = useCallback(() => act({ action: "start" }), [act]);
  const logout = useCallback(() => act({ action: "logout" }), [act]);
  const deleteLocal = useCallback(() => act({ action: "delete" }), [act]);

  return {
    status,
    busy,
    failure,
    refresh,
    connect,
    logout,
    deleteLocal,
    submitPassword: (entered: string) => {
      const operationId = statusRef.current?.login?.operationId;
      if (!operationId) return Promise.resolve();
      return act({ action: "password", operationId, password: entered });
    },
    cancel: () => {
      const operationId = statusRef.current?.login?.operationId;
      if (!operationId) return Promise.resolve();
      return act({ action: "cancel", operationId });
    },
  };
}
