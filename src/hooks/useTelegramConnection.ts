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

export type TelegramConnectionState = {
  status: TelegramStatusPayload | null;
  busy: boolean;
  /** Transport-level failure of the last action (server errors ride in
      `status.error` instead). */
  failed: boolean;
  refresh(fresh?: boolean): Promise<void>;
  connect(): Promise<void>;
  submitPassword(password: string): Promise<void>;
  cancel(): Promise<void>;
  logout(): Promise<void>;
  deleteLocal(): Promise<void>;
};

async function readPayload(response: Response): Promise<TelegramStatusPayload | null> {
  if (!response.ok) return null;
  const json = await response.json() as { telegram?: TelegramStatusPayload };
  return json.telegram ?? null;
}

export function useTelegramConnection(): TelegramConnectionState {
  const [status, setStatus] = useState<TelegramStatusPayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  /* Latest payload for event handlers and the poll loop; written only where
     a payload actually arrives, never during render. */
  const statusRef = useRef<TelegramStatusPayload | null>(null);

  const apply = useCallback((payload: TelegramStatusPayload) => {
    statusRef.current = payload;
    setStatus(payload);
  }, []);

  const load = useCallback(async (fresh: boolean): Promise<TelegramStatusPayload | null> => {
    try {
      const payload = await readPayload(await fetch(`/api/telegram${fresh ? "?fresh=1" : ""}`));
      if (payload) apply(payload);
      return payload;
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
    setFailed(false);
    try {
      const response = await fetch("/api/telegram", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await readPayload(response);
      if (payload) apply(payload);
      else {
        setFailed(true);
        await refresh();
      }
    } catch {
      setFailed(true);
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
    failed,
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
