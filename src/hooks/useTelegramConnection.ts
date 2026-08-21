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
  /** #1070: persist operator-entered API credentials (api_id + api_hash) into
      the host's telegram.json, then the panel proceeds to the Connect flow. */
  saveCredentials(apiId: string, apiHash: string): Promise<void>;
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
  const loadSequenceRef = useRef(0);

  const apply = useCallback((payload: TelegramStatusPayload) => {
    statusRef.current = payload;
    setStatus(payload);
  }, []);

  const load = useCallback(async (fresh: boolean, preserveExistingFailure = false): Promise<TelegramStatusPayload | null> => {
    const sequence = ++loadSequenceRef.current;
    try {
      const outcome = await readOutcome(await fetch(`/api/telegram${fresh ? "?fresh=1" : ""}`));
      if (sequence !== loadSequenceRef.current) return null;
      if (outcome.payload) {
        apply(outcome.payload);
        if (!preserveExistingFailure) setFailure(null);
      } else {
        setFailure({ code: outcome.code });
      }
      return outcome.payload;
    } catch {
      if (sequence === loadSequenceRef.current) setFailure({ code: "transport" });
      /* A failed poll keeps the last known status and surfaces the failure. */
      return null;
    }
  }, [apply]);

  const refresh = useCallback(async (fresh = false) => {
    await load(fresh);
  }, [load]);

  const liveLogin = status?.login != null && NONTERMINAL_TELEGRAM_LOGIN_PHASES.has(status.phase);
  const credentialRecovery = status?.phase === "connected"
    || (status?.phase === "error" && status.credentialRef !== null);
  const pollingMode = liveLogin ? "login" : credentialRecovery ? "health" : "idle";

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      const current = statusRef.current;
      const fresh = current?.phase === "connected"
        || (current?.phase === "error" && current.credentialRef !== null);
      const payload = (await load(fresh)) ?? statusRef.current;
      if (disposed) return;
      const live = payload?.login != null && NONTERMINAL_TELEGRAM_LOGIN_PHASES.has(payload.phase);
      timer = setTimeout(() => void tick(), live ? LOGIN_POLL_MS : IDLE_POLL_MS);
    };
    void tick();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, [load, pollingMode]);

  const act = useCallback(async (body: Record<string, string>) => {
    /* A mutation response is the authoritative state transition. Invalidate
       polls already in flight now, and again when the mutation resolves so a
       GET started while the POST was pending cannot repaint older state. */
    loadSequenceRef.current += 1;
    setBusy(true);
    setFailure(null);
    try {
      const response = await fetch("/api/telegram", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const outcome = await readOutcome(response);
      if (outcome.payload) {
        loadSequenceRef.current += 1;
        apply(outcome.payload);
      }
      else {
        /* The backend's sanitized code survives to the panel, and the status
           re-syncs so the phase on screen stays the server's. */
        setFailure({ code: outcome.code });
        await load(true, true);
      }
    } catch {
      loadSequenceRef.current += 1;
      setFailure({ code: "transport" });
    } finally {
      setBusy(false);
    }
  }, [apply, load]);

  const connect = useCallback(() => act({ action: "start" }), [act]);
  const saveCredentials = useCallback((apiId: string, apiHash: string) => act({ action: "credentials", apiId, apiHash }), [act]);
  const logout = useCallback(() => act({ action: "logout" }), [act]);
  const deleteLocal = useCallback(() => act({ action: "delete" }), [act]);

  return {
    status,
    busy,
    failure,
    refresh,
    connect,
    saveCredentials,
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
