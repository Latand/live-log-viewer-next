"use client";

import { useEffect, useRef, useState } from "react";
import { mintIdempotencyKey } from "@/components/runtime/runtimeModel";

export interface ConversationControlTarget { conversationId?: string; path?: string }
type Outcome = "idle" | "pending" | "done" | "failed" | "unknown";
interface ControlState { outcome: Outcome; error?: string }
interface ControlReceipt { operationId: string; conversationId?: string; kind?: string; status: string; error?: string | null; reason?: string | null }

function receiptState(receipt: ControlReceipt): ControlState {
  if (receipt.status === "delivered" || (receipt.kind === "interrupt" && receipt.status === "interrupted")) return { outcome: "done" };
  if (["failed", "rejected", "cancelled", "superseded"].includes(receipt.status)) {
    return { outcome: "failed", error: receipt.error ?? receipt.reason ?? undefined };
  }
  return { outcome: ["queued", "pending", "delivering", "applying"].includes(receipt.status) ? "pending" : "unknown" };
}

/** One operator gesture and its original receipt. Polling only reads status;
    a lost answer never resends a stop against a possibly resumed host. */
export function useConversationControl(target: ConversationControlTarget, action: "interrupt" | "kill") {
  const identity = `${target.conversationId ?? ""}:${target.path ?? ""}:${action}`;
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const operation = useRef<{ id: string; identity: string } | null>(null);
  const [state, setState] = useState<ControlState>({ outcome: "idle" });
  const [watch, setWatch] = useState<string | null>(null);

  useEffect(() => {
    operation.current = null;
    setWatch(null);
    setState({ outcome: "idle" });
  }, [identity]);

  useEffect(() => {
    if (!watch) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      try {
        const response = await fetch(`/api/runtime/operations/${encodeURIComponent(watch)}`, { signal: AbortSignal.timeout(5_000) });
        const body = await response.json() as { receipt?: ControlReceipt };
        if (cancelled || currentIdentity.current !== identity) return;
        const receipt = body.receipt;
        if (response.ok && receipt?.operationId === watch
          && (!target.conversationId || receipt.conversationId === target.conversationId)
          && receipt.kind === action) {
          const next = receiptState(receipt);
          setState(next);
          if (next.outcome === "done" || next.outcome === "failed") {
            operation.current = null;
            setWatch(null);
            return;
          }
        } else setState({ outcome: "unknown" });
      } catch {
        if (!cancelled && currentIdentity.current === identity) setState({ outcome: "unknown" });
      }
      if (!cancelled) timer = setTimeout(check, 1000);
    };
    timer = setTimeout(check, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [watch, identity, target.conversationId, action]);

  const run = async (): Promise<boolean> => {
    if (operation.current?.identity === identity) return false;
    const id = mintIdempotencyKey();
    operation.current = { id, identity };
    setState({ outcome: "pending" });
    try {
      const response = await fetch("/api/conversation-host", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...target, action, operationId: id }),
      });
      const body = await response.json() as { ok?: boolean; error?: string; receipt?: ControlReceipt };
      if (currentIdentity.current !== identity || operation.current?.id !== id) return false;
      const receipt = body.receipt;
      if (receipt && (receipt.operationId !== id
        || (receipt.conversationId !== undefined && target.conversationId && receipt.conversationId !== target.conversationId)
        || (receipt.kind !== undefined && receipt.kind !== action))) {
        setState({ outcome: "unknown", error: "receipt-identity-mismatch" });
        setWatch(id);
        return false;
      }
      if (receipt) {
        const next = receiptState(receipt);
        setState(next);
        if (next.outcome === "pending" || next.outcome === "unknown") setWatch(id);
        else operation.current = null;
        return response.ok && body.ok === true && next.outcome === "done";
      }
      if (response.status >= 500 || response.status === 202) {
        setState({ outcome: "unknown" });
        setWatch(id);
        return false;
      }
      const accepted = response.ok && body.ok === true;
      setState(accepted ? { outcome: "done" } : { outcome: "failed", error: body.error });
      operation.current = null;
      return accepted;
    } catch {
      if (currentIdentity.current === identity && operation.current?.id === id) {
        setState({ outcome: "unknown" });
        setWatch(id);
      }
      return false;
    }
  };
  return { ...state, busy: state.outcome === "pending" || state.outcome === "unknown", run };
}
